/**
 * A private worker is a route target. The API always took private_worker_id
 * on a route, but the Routing tab's selector listed deployments only, so a
 * connected worker could not be put behind a domain from the panel.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DomainDetail from '../pages/DomainDetail';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/hooks/use-tenant-context', () => ({
  useTenantContext: vi.fn(() => ({ tenantId: 'c1', tenantName: 'Test Corp', isLoading: false })),
}));
vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

const mockApiFetch = vi.mocked(apiFetch);
const DOMAIN = {
  id: 'd1', tenantId: 'c1', domainName: 'example.com', status: 'active', dnsMode: 'primary',
  sslAutoRenew: 1, createdAt: '2026-01-10T00:00:00Z',
};
let route: Record<string, unknown>;
const WORKERS = [
  { id: 'w1', name: 'immich', slug: 'immich-3c25', status: 'pending', exposedPort: 10000 },
  { id: 'w2', name: 'old', slug: 'old-1', status: 'revoked', exposedPort: 10001 },
];

beforeEach(() => {
  vi.clearAllMocks();
  route = {
    id: 'route-1', domainId: 'd1', hostname: 'photos.example.com', path: '/', targetType: 'deployment',
    deploymentId: null, privateWorkerId: null, ingressCname: 'x', nodeHostname: null, isApex: 0, tlsMode: 'auto', status: 'active',
  };
  mockApiFetch.mockImplementation((url: string, init?: { method?: string }) => {
    if (url.includes('/routes/') && init?.method === 'PATCH') return Promise.resolve({ data: route }) as never;
    if (url.includes('/private-workers')) return Promise.resolve({ data: { items: WORKERS } }) as never;
    if (url.includes('/routes')) return Promise.resolve({ data: [route] }) as never;
    if (url.includes('/platform/ingress-base-domain')) return Promise.resolve({ data: { ingressBaseDomain: 'ingress.example.net' } }) as never;
    if (url.includes('/domains') && !url.includes('/dns-records')) {
      return Promise.resolve({ data: [DOMAIN], pagination: { total_count: 1, cursor: null, has_more: false, page_size: 50 } }) as never;
    }
    return Promise.resolve({ data: [] }) as never;
  });
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/domains/d1']}>
        <Routes>
          <Route path="/domains/:domainId" element={<DomainDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const targetSelect = async () => {
  const option = await screen.findByTestId('route-target-worker-w1');
  return option.closest('select') as HTMLSelectElement;
};

describe('Routing tab — a private worker as the route target', () => {
  it('★ lists the tenant\'s workers, a pending one included, and not a revoked one', async () => {
    renderPage();
    const select = await targetSelect();
    const group = select.querySelector('optgroup[label="Private workers"]') as HTMLElement;
    expect(within(group).getByText('immich (private worker, not connected yet)')).toBeInTheDocument();
    expect(within(group).queryByText(/old/)).toBeNull();
  });

  it('sends private_worker_id — and clears the deployment — when one is picked', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.selectOptions(await targetSelect(), 'pw:w1');
    const patch = mockApiFetch.mock.calls.find(([u, i]) => String(u).includes('/routes/route-1') && (i as { method?: string })?.method === 'PATCH');
    expect(JSON.parse(String((patch![1] as { body: string }).body))).toEqual({
      private_worker_id: 'w1', deployment_id: null, service_port: null,
    });
  });

  it('shows a route that already points at a worker as such', async () => {
    route = { ...route, targetType: 'private_worker', privateWorkerId: 'w1' };
    renderPage();
    expect((await targetSelect()).value).toBe('pw:w1');
  });
});

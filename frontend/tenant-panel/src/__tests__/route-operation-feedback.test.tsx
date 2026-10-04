/**
 * Removing a route waits on the DNS server, which can take most of a minute.
 * While it runs the Routing tab says what it is doing, and afterwards how it
 * ended — including when DNS records are still published.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
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
const ROUTE = {
  id: 'route-1', domainId: 'd1', hostname: 'moodle.example.com', path: '/', targetType: 'deployment',
  deploymentId: null, privateWorkerId: null, ingressCname: 'x', nodeHostname: null, isApex: 0, tlsMode: 'auto',
  status: 'active',
};

function deferredDelete() {
  let settle!: { resolve: (v: unknown) => void; reject: (e: unknown) => void };
  const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  mockApiFetch.mockImplementation((url: string, init?: { method?: string }) => {
    if (url.includes('/routes/') && init?.method === 'DELETE') return promise as never;
    if (url.includes('/routes')) return Promise.resolve({ data: [ROUTE] }) as never;
    if (url.includes('/platform/ingress-base-domain')) return Promise.resolve({ data: { ingressBaseDomain: 'ingress.example.net' } }) as never;
    if (url.includes('/domains') && !url.includes('/dns-records')) {
      return Promise.resolve({ data: [DOMAIN], pagination: { total_count: 1, cursor: null, has_more: false, page_size: 50 } }) as never;
    }
    return Promise.resolve({ data: [] }) as never;
  });
  return settle;
}

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

async function startRemoval() {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByTestId('route-delete-route-1'));
  await user.click(screen.getByTestId('route-delete-confirm-route-1'));
}

beforeEach(() => vi.clearAllMocks());

describe('removing a route (tenant)', () => {
  it('shows a spinner and says what it is doing while the removal runs', async () => {
    const settle = deferredDelete();
    await startRemoval();

    const status = await screen.findByTestId('route-operation-pending');
    expect(status).toHaveTextContent('Removing moodle.example.com — withdrawing its DNS records and updating the ingress…');
    expect(status.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.getByTestId('route-removing-route-1')).toHaveTextContent('Removing…');

    settle.resolve({ data: { dnsWarning: null } });
    expect(await screen.findByTestId('route-operation-done')).toHaveTextContent('Removed moodle.example.com.');
  });

  it('says so when DNS records are still published', async () => {
    const settle = deferredDelete();
    await startRemoval();
    settle.resolve({ data: { dnsWarning: "The route is removed, but the DNS records for 'moodle.example.com' are still published: the DNS server could not withdraw them right now." } });
    expect(await screen.findByTestId('route-operation-warning')).toHaveTextContent('could not withdraw them right now');
  });

  it('shows why a removal failed', async () => {
    const settle = deferredDelete();
    await startRemoval();
    settle.reject(new Error('Ingress route not found'));
    const error = await screen.findByTestId('route-delete-error');
    expect(within(error).getByText(/Ingress route not found/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('route-operation-pending')).toBeNull());
  });
});

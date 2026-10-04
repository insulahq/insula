/**
 * Removing a route waits on the DNS server; one that did not answer kept the
 * request open for 42 s with nothing on the page moving, and the operator
 * clicked again. While a route change runs, the page says what it is doing,
 * and afterwards how it ended.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DomainDetail from '../pages/DomainDetail';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
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
  id: 'domain-1', tenantId: 'tenant-1', domainName: 'example.com', status: 'active', dnsMode: 'primary',
  sslAutoRenew: 1, createdAt: '2026-01-10T00:00:00Z',
};
const ROUTE = {
  id: 'route-1', domainId: 'domain-1', hostname: 'moodle.example.com', path: '/', targetType: 'deployment',
  deploymentId: null, privateWorkerId: null, ingressCname: 'x', nodeHostname: null, isApex: 0, tlsMode: 'auto',
  status: 'active',
};
const ROUTE_2 = { ...ROUTE, id: 'route-2', hostname: 'www.example.com' };
const DEPLOYMENT = { id: 'dep-1', name: 'moodle', status: 'running' };

/** A DELETE the test settles by hand, so it can look at the page while it runs. */
function deferredDelete() {
  let settle!: { resolve: (v: unknown) => void; reject: (e: unknown) => void };
  const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  mockApiFetch.mockImplementation((url: string, init?: { method?: string }) => {
    if (url.includes('/routes/') && init?.method === 'DELETE') return promise as never;
    if (url.includes('/routes/') && init?.method === 'PATCH') return promise as never;
    if (url.includes('/routes')) return Promise.resolve({ data: [ROUTE, ROUTE_2] }) as never;
    if (url.includes('/deployments')) return Promise.resolve({ data: [DEPLOYMENT] }) as never;
    if (url.includes('/domains') && !url.includes('/dns-records')) {
      return Promise.resolve({ data: [DOMAIN], pagination: { total_count: 1, cursor: null, has_more: false, page_size: 100 } }) as never;
    }
    return Promise.resolve({ data: [] }) as never;
  });
  return settle;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/tenants/tenant-1/domains/domain-1']}>
        <Routes>
          <Route path="/tenants/:tenantId/domains/:domainId" element={<DomainDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function startRemoval() {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByTestId('route-delete-route-1'));
  // One click only asks; nothing is sent yet.
  expect(mockApiFetch.mock.calls.some(([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE')).toBe(false);
  await user.click(screen.getByTestId('route-delete-confirm-route-1'));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('removing a route (admin)', () => {
  it('shows a spinner and says what it is doing while the removal runs', async () => {
    const settle = deferredDelete();
    await startRemoval();

    const status = await screen.findByTestId('route-operation-pending');
    expect(status).toHaveTextContent('Removing moodle.example.com — withdrawing its DNS records and updating the ingress…');
    expect(status).toHaveTextContent('can take up to a minute');
    expect(status.querySelector('.animate-spin')).not.toBeNull();
    const row = screen.getByTestId('route-removing-route-1');
    expect(row).toHaveTextContent('Removing…');
    expect(row.querySelector('.animate-spin')).not.toBeNull();

    settle.resolve({ data: { dnsWarning: null } });
    expect(await screen.findByTestId('route-operation-done')).toHaveTextContent('Removed moodle.example.com.');
    expect(screen.queryByTestId('route-operation-pending')).toBeNull();
  });

  it('says so when the route is gone but its DNS records are still published', async () => {
    const settle = deferredDelete();
    await startRemoval();
    settle.resolve({ data: { dnsWarning: "The route is removed, but the DNS records for 'moodle.example.com' are still published: timed out." } });
    expect(await screen.findByTestId('route-operation-warning')).toHaveTextContent('are still published');
  });

  it('copes with a server that still answers 204', async () => {
    const settle = deferredDelete();
    await startRemoval();
    settle.resolve(undefined);
    expect(await screen.findByTestId('route-operation-done')).toHaveTextContent('Removed moodle.example.com.');
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

describe('changing a route (admin)', () => {
  it('shows the change in progress and holds other rows until it is done', async () => {
    const settle = deferredDelete();
    const user = userEvent.setup();
    renderPage();
    const first = await screen.findByTestId('route-deployment-route-1');
    await waitFor(() => expect(within(first).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(first, 'dep-1');

    expect(await screen.findByTestId('route-operation-pending')).toHaveTextContent('Updating moodle.example.com');
    expect(screen.getByTestId('route-updating-route-1')).toBeInTheDocument();
    // A second change now would hide the first one's spinner mid-flight.
    expect(screen.getByTestId('route-deployment-route-2')).toBeDisabled();

    settle.resolve({ data: ROUTE });
    await waitFor(() => expect(screen.getByTestId('route-deployment-route-2')).not.toBeDisabled());
  });
});

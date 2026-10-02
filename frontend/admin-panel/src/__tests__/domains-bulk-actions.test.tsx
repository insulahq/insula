import { render, screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiFetch, ApiError } from '@/lib/api-client';

/**
 * Tenants → Domains bulk bar, end to end through the tab: select rows, pick
 * an action, confirm, and watch the progress modal drive one request per
 * domain. The list hooks are stubbed; every action request goes through the
 * mocked `apiFetch`, which is what these tests observe.
 */

vi.mock('@/lib/api-client', () => ({
  API_BASE: '',
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
      public readonly details?: Record<string, unknown>,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

const DOMAINS = [
  { id: 'd1', tenantId: 't1', domainName: 'alpha.example.test', status: 'active', dnsMode: 'primary', sslAutoRenew: 1, createdAt: '2026-01-01T00:00:00Z' },
  { id: 'd2', tenantId: 't1', domainName: 'bravo.example.test', status: 'active', dnsMode: 'cname', sslAutoRenew: 1, createdAt: '2026-01-01T00:00:00Z' },
  { id: 'd3', tenantId: 't2', domainName: 'charlie.example.test', status: 'active', dnsMode: 'primary', sslAutoRenew: 1, createdAt: '2026-01-01T00:00:00Z' },
];

vi.mock('@/hooks/use-domains', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-domains')>()),
  useDomains: () => ({
    data: { data: DOMAINS, pagination: { total_count: 3, cursor: null, has_more: false, page_size: 20 } },
    isLoading: false,
    error: null,
  }),
}));

vi.mock('@/hooks/use-tenants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-tenants')>()),
  useTenants: () => ({ data: { data: [{ id: 't1', name: 'Tenant One' }, { id: 't2', name: 'Tenant Two' }] }, isLoading: false }),
  useTenant: () => ({ data: undefined, isLoading: false }),
}));

const DomainsTab = (await import('@/pages/tenants/DomainsTab')).default;
const mockApiFetch = vi.mocked(apiFetch);

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter><DomainsTab /></MemoryRouter>
    </QueryClientProvider>,
  );
  return { invalidate };
}

function refreshCalls(): string[] {
  return mockApiFetch.mock.calls
    .map(([url]) => url)
    .filter((url) => url.endsWith('/refresh-route-dns'));
}

async function selectAllAndRun(user: ReturnType<typeof userEvent.setup>, actionTestId: string) {
  // The first checkbox is the header "select all".
  await user.click(screen.getAllByTestId('select-checkbox')[0]);
  await user.click(screen.getByTestId(actionTestId));
  await user.click(screen.getByTestId('bulk-confirm'));
}

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('Tenants → Domains bulk actions', () => {
  it('offers Refresh Route DNS in the bulk bar', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getAllByTestId('select-checkbox')[1]);
    expect(within(screen.getByTestId('bulk-action-bar')).getByText('Refresh Route DNS')).toBeInTheDocument();
  });

  it('refreshes one domain at a time: the next request waits for the previous one', async () => {
    const user = userEvent.setup();
    const resolvers: Array<(v: unknown) => void> = [];
    mockApiFetch.mockImplementation((url: string) => (
      url.endsWith('/refresh-route-dns')
        ? new Promise((resolve) => { resolvers.push(resolve); })
        : Promise.resolve({ data: [] })
    ));
    renderTab();

    await selectAllAndRun(user, 'bulk-refresh-route-dns');
    expect(screen.getByTestId('bulk-run-modal')).toBeInTheDocument();
    await waitFor(() => expect(refreshCalls()).toHaveLength(1));
    // Give a fan-out every chance to issue the rest before asserting it did not.
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(refreshCalls()).toEqual(['/api/v1/tenants/t1/domains/d1/refresh-route-dns']);
    expect(screen.getByTestId('bulk-run-row-d2')).toHaveAttribute('data-status', 'queued');

    act(() => resolvers[0]({ data: { hostnames: 1, created: 1, removed: 0, failures: [] } }));
    await waitFor(() => expect(refreshCalls()).toHaveLength(2));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(refreshCalls()).toHaveLength(2);
    expect(refreshCalls()[1]).toBe('/api/v1/tenants/t1/domains/d2/refresh-route-dns');

    act(() => resolvers[1]({ data: { hostnames: 1, created: 1, removed: 0, failures: [] } }));
    await waitFor(() => expect(refreshCalls()).toHaveLength(3));
    expect(refreshCalls()[2]).toBe('/api/v1/tenants/t2/domains/d3/refresh-route-dns');
    act(() => resolvers[2]({ data: { hostnames: 1, created: 1, removed: 0, failures: [] } }));

    await waitFor(() => expect(screen.getByTestId('bulk-run-summary')).toHaveTextContent('3 succeeded, 0 skipped, 0 failed'));
  });

  it('classifies success / 409 skip / per-hostname failure, reports once, and keeps only the failure selected', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/d1/')) return Promise.resolve({ data: { hostnames: 2, created: 2, removed: 1, failures: [] } });
      if (url.includes('/d2/')) {
        return Promise.reject(new ApiError(409, 'DNS_MODE_NOT_PRIMARY', 'needs primary mode'));
      }
      if (url.includes('/d3/')) {
        return Promise.resolve({
          data: { hostnames: 2, created: 1, removed: 2, failures: [{ hostname: 'www.charlie.example.test', detail: 'DNS server rejected the record' }] },
        });
      }
      return Promise.resolve({ data: [] });
    });
    const { invalidate } = renderTab();

    await selectAllAndRun(user, 'bulk-refresh-route-dns');
    await waitFor(() => expect(screen.getByTestId('bulk-run-summary')).toHaveTextContent('1 succeeded, 1 skipped, 1 failed'));

    expect(screen.getByTestId('bulk-run-row-d1')).toHaveAttribute('data-status', 'succeeded');
    expect(screen.getByTestId('bulk-run-detail-d1')).toHaveTextContent('2 hostnames, 2 refreshed, 1 stale record removed');
    expect(screen.getByTestId('bulk-run-row-d2')).toHaveAttribute('data-status', 'skipped');
    expect(screen.getByTestId('bulk-run-detail-d2')).toHaveTextContent('not a primary-mode domain');
    expect(screen.getByTestId('bulk-run-row-d3')).toHaveAttribute('data-status', 'failed');
    expect(within(screen.getByTestId('bulk-run-row-d3')).getByText('www.charlie.example.test: DNS server rejected the record')).toBeInTheDocument();
    expect(within(screen.getByTestId('bulk-run-error')).getByText('BULK_PARTIAL_FAILURE')).toBeInTheDocument();

    // Invalidated once for the whole run, not once per domain.
    const domainInvalidations = invalidate.mock.calls.filter(([f]) => JSON.stringify(f?.queryKey) === '["domains"]');
    expect(domainInvalidations).toHaveLength(1);

    await user.click(screen.getByTestId('bulk-run-close'));
    expect(screen.queryByTestId('bulk-run-modal')).not.toBeInTheDocument();
    expect(screen.getByTestId('bulk-selected-count')).toHaveTextContent('1 selected');
  });

  it('"Retry failed" re-requests only the failed domain', async () => {
    const user = userEvent.setup();
    let d3Attempts = 0;
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/d3/')) {
        d3Attempts += 1;
        return d3Attempts === 1
          ? Promise.reject(new ApiError(502, 'DNS_PROVIDER_UNREACHABLE', 'provider unreachable'))
          : Promise.resolve({ data: { hostnames: 1, created: 1, removed: 1, failures: [] } });
      }
      if (url.endsWith('/refresh-route-dns')) return Promise.resolve({ data: { hostnames: 1, created: 1, removed: 0, failures: [] } });
      return Promise.resolve({ data: [] });
    });
    renderTab();

    await selectAllAndRun(user, 'bulk-refresh-route-dns');
    await waitFor(() => expect(screen.getByTestId('bulk-run-summary')).toHaveTextContent('2 succeeded, 0 skipped, 1 failed'));
    expect(screen.getByTestId('bulk-run-detail-d3')).toHaveTextContent('provider unreachable (DNS_PROVIDER_UNREACHABLE)');

    mockApiFetch.mockClear();
    await user.click(screen.getByTestId('bulk-run-retry-failed'));
    await waitFor(() => expect(screen.getByTestId('bulk-run-summary')).toHaveTextContent('3 succeeded, 0 skipped, 0 failed'));
    expect(refreshCalls()).toEqual(['/api/v1/tenants/t2/domains/d3/refresh-route-dns']);

    await user.click(screen.getByTestId('bulk-run-close'));
    expect(screen.getByTestId('bulk-selected-count')).toHaveTextContent('0 selected');
  });

  it('existing actions run through the same modal: delete sends one id per request', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/v1/admin/domains/bulk') {
        const id = (JSON.parse(String(init?.body)) as { domain_ids: string[] }).domain_ids[0];
        return Promise.resolve({ data: { succeeded: [id], failed: [] } });
      }
      return Promise.resolve({ data: [] });
    });
    renderTab();

    await selectAllAndRun(user, 'bulk-delete-domains');
    await waitFor(() => expect(screen.getByTestId('bulk-run-summary')).toHaveTextContent('3 succeeded, 0 skipped, 0 failed'));
    const bodies = mockApiFetch.mock.calls
      .filter(([url]) => url === '/api/v1/admin/domains/bulk')
      .map(([, init]) => JSON.parse(String(init?.body)) as { domain_ids: string[] });
    expect(bodies.map((b) => b.domain_ids)).toEqual([['d1'], ['d2'], ['d3']]);
  });
});

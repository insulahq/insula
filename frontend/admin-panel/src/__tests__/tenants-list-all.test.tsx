/**
 * Admin → Tenants → List: "All" rows per page, and a search box that says
 * what it matches.
 *
 * The API caps a page at 100, so "All" follows the cursor to the end rather
 * than asking for a page size the API refuses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch }));

const tenant = (i: number) => ({
  id: `t-${i}`, name: `Tenant ${String(i).padStart(3, '0')}`, primaryEmail: `t${i}@example.test`, status: 'active',
  isSystem: false, planId: 'p', planName: 'Pro', nodeName: null, storageTier: 'local', placement: null,
  subscriptionExpiresAt: null,
});

describe('fetchAllTenants', () => {
  beforeEach(() => { apiFetch.mockReset(); });

  it('follows the cursor at the largest page the API allows, and returns every tenant as one page', async () => {
    const { fetchAllTenants } = await import('@/hooks/use-tenants');
    apiFetch
      .mockResolvedValueOnce({ data: Array.from({ length: 100 }, (_, i) => tenant(i)), pagination: { has_more: true, cursor: 'c1', total_count: 230, page_size: 100 } })
      .mockResolvedValueOnce({ data: Array.from({ length: 100 }, (_, i) => tenant(100 + i)), pagination: { has_more: true, cursor: 'c2', total_count: 230, page_size: 100 } })
      .mockResolvedValueOnce({ data: Array.from({ length: 30 }, (_, i) => tenant(200 + i)), pagination: { has_more: false, cursor: null, total_count: 230, page_size: 30 } });

    const all = await fetchAllTenants('acme');

    expect(apiFetch.mock.calls.map((c) => c[0])).toEqual([
      '/api/v1/tenants?search=acme&limit=100',
      '/api/v1/tenants?search=acme&limit=100&cursor=c1',
      '/api/v1/tenants?search=acme&limit=100&cursor=c2',
    ]);
    expect(all.data).toHaveLength(230);
    expect(all.pagination).toEqual({ total_count: 230, cursor: null, has_more: false, page_size: 230 });
  });
});

describe('TenantsListTab — All rows', () => {
  let lastParams: Record<string, unknown> = {};

  beforeEach(() => {
    lastParams = {};
    vi.resetModules();
    vi.doMock('@/hooks/use-tenants', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/hooks/use-tenants')>()),
      useTenants: (params: Record<string, unknown>) => {
        lastParams = params;
        return { data: { data: [tenant(1)], pagination: { total_count: 1, cursor: null, has_more: false, page_size: 1 } }, isLoading: false, error: null };
      },
    }));
    vi.doMock('@/hooks/use-impersonate', () => ({
      useLoginAsTenant: () => ({ open: vi.fn(), isPending: false, error: null, isUnconfigured: false }),
    }));
    vi.doMock('@/hooks/use-resource-metrics', () => ({ useAllTenantMetrics: () => ({ data: { data: {} }, isLoading: false }) }));
    vi.doMock('@/hooks/use-tenant-issues', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/hooks/use-tenant-issues')>()),
      useTenantIssues: () => ({ data: { data: {} } }),
    }));
    vi.doMock('@/components/outage/TenantHealthChip', () => ({ default: () => null }));
    vi.doMock('@/components/CreateTenantModal', () => ({ default: () => null }));
    vi.doMock('@/components/BulkRunModal', () => ({ default: () => null }));
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({ data: [] });
  });

  async function renderList() {
    const TenantsListTab = (await import('@/pages/tenants/TenantsListTab')).default;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter><TenantsListTab /></MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('offers All, and asks for every tenant when it is picked', async () => {
    await renderList();
    expect(lastParams).toMatchObject({ limit: 20 });
    const select = screen.getByTestId('page-size-select');
    expect([...(select as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['20', '50', '100', 'All']);
    fireEvent.change(select, { target: { value: '-1' } });
    expect(lastParams).toEqual({ search: undefined, all: true });
    expect(screen.getByTestId('pagination-bar').textContent).toMatch(/Showing 1-1 of 1/);
  });

  it('says the search matches plan and placement', async () => {
    await renderList();
    expect(screen.getByTestId('tenant-search').getAttribute('placeholder')).toMatch(/plan or placement/);
  });
});

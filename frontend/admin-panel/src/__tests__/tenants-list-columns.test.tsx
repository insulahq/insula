/**
 * Admin → Tenants → List: no email addresses in the table, a Plan column,
 * every column sortable, and the Change placement / Change plan bulk actions
 * (SYSTEM tenant excluded, one tenant at a time through the shared runner).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/hooks/use-impersonate', () => ({
  useLoginAsTenant: () => ({ open: vi.fn(), isPending: false, error: null, isUnconfigured: false }),
}));

const TENANTS = [
  {
    id: 't-1', name: 'Bravo Ltd', primaryEmail: 'bravo@example.test', secondaryEmail: 'b2@example.test',
    status: 'active', isSystem: false, planId: 'p-pro', planName: 'Pro', nodeName: 'node-10', storageTier: 'local',
    placement: null, subscriptionExpiresAt: '2027-01-01T00:00:00Z',
  },
  {
    id: 't-2', name: 'Alpha GmbH', primaryEmail: 'alpha@example.test', secondaryEmail: null,
    status: 'active', isSystem: false, planId: 'p-basic', planName: 'Basic', nodeName: 'node-2', storageTier: 'ha',
    placement: null, subscriptionExpiresAt: null,
  },
  {
    id: 't-sys', name: 'SYSTEM', primaryEmail: 'sys@example.test', secondaryEmail: null,
    status: 'active', isSystem: true, planId: 'p-basic', planName: 'Basic', nodeName: null, storageTier: 'local',
    placement: null, subscriptionExpiresAt: null,
  },
];

vi.mock('@/hooks/use-tenants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-tenants')>()),
  useTenants: () => ({ data: { data: TENANTS, pagination: {} }, isLoading: false, error: null }),
}));

const metricOf = (cpu: number) => ({
  tenantId: 'x',
  cpu: { inUse: cpu, reserved: null, available: 4 },
  memory: { inUse: 10 - cpu, reserved: null, available: 100 },
  storage: { inUse: cpu * 3, reserved: null, available: 100 },
  lastUpdatedAt: '2026-10-01T00:00:00Z',
});
vi.mock('@/hooks/use-resource-metrics', () => ({
  useAllTenantMetrics: () => ({ data: { data: { 't-1': metricOf(0.5), 't-2': metricOf(2), 't-sys': metricOf(1) } }, isLoading: false }),
}));

const moveTenantToNodeItem = vi.fn();
const changeTenantPlanItem = vi.fn();
vi.mock('@/hooks/use-bulk-tenants', () => ({
  runTenantBulkItem: vi.fn(),
  moveTenantToNodeItem: (...a: unknown[]) => moveTenantToNodeItem(...a),
  changeTenantPlanItem: (...a: unknown[]) => changeTenantPlanItem(...a),
  useInvalidateTenantQueries: () => () => {},
}));

const start = vi.fn();
vi.mock('@/hooks/use-bulk-run', () => ({
  useBulkRun: () => ({ state: null, start, cancel: vi.fn(), retryFailed: vi.fn(), close: vi.fn() }),
}));

vi.mock('@/hooks/use-cluster-nodes', () => ({
  useClusterNodes: () => ({
    data: { data: [
      { name: 'node-2', canHostTenantWorkloads: true },
      { name: 'node-cp', canHostTenantWorkloads: false },
    ] },
    isLoading: false,
  }),
}));
vi.mock('@/hooks/use-plans', () => ({
  usePlans: () => ({ data: { data: [{ id: 'p-pro', name: 'Pro', monthlyPriceUsd: '20.00' }] }, isLoading: false }),
}));
vi.mock('@/hooks/use-system-info', () => ({ useSystemInfo: () => ({ data: { currency: 'USD' } }) }));

vi.mock('@/components/CreateTenantModal', () => ({ default: () => null }));
vi.mock('@/components/BulkRunModal', () => ({ default: () => null }));

const TenantsListTab = (await import('@/pages/tenants/TenantsListTab')).default;

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, enabled: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><TenantsListTab /></MemoryRouter>
    </QueryClientProvider>,
  );
}

const rowNames = (): string[] => within(screen.getByTestId('tenants-table'))
  .getAllByRole('row')
  .slice(1)
  .map((r) => (r.querySelector('td:nth-child(2) span')?.textContent ?? '').trim());

describe('TenantsListTab — columns', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows no email address anywhere in the table', () => {
    renderList();
    expect(screen.getByTestId('tenants-table').textContent).not.toMatch(/@/);
  });

  it('has a Plan column with each tenant\'s plan name', () => {
    renderList();
    expect(screen.getByTestId('sort-planName').textContent).toContain('Plan');
    expect(screen.getByTestId('tenant-plan-t-1').textContent).toBe('Pro');
    expect(screen.getByTestId('tenant-plan-t-2').textContent).toBe('Basic');
  });

  it('makes every column sortable, each changing the order', () => {
    renderList();
    expect(rowNames()).toEqual(['Alpha GmbH', 'Bravo Ltd', 'SYSTEM']);
    const keys = ['name', 'status', 'cpu', 'memory', 'storage', 'placement', 'storageTier', 'planName', 'subscriptionExpiresAt'];
    for (const key of keys) expect(screen.getByTestId(`sort-${key}`)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sort-cpu')); // 0.5, 1, 2 — numeric
    expect(rowNames()).toEqual(['Bravo Ltd', 'SYSTEM', 'Alpha GmbH']);
    fireEvent.click(screen.getByTestId('sort-cpu'));
    expect(rowNames()).toEqual(['Alpha GmbH', 'SYSTEM', 'Bravo Ltd']);

    fireEvent.click(screen.getByTestId('sort-placement')); // node-2 < node-10, auto last
    expect(rowNames()).toEqual(['Alpha GmbH', 'Bravo Ltd', 'SYSTEM']);

    fireEvent.click(screen.getByTestId('sort-planName'));
    expect(rowNames()[2]).toBe('Bravo Ltd'); // Basic, Basic, Pro

    fireEvent.click(screen.getByTestId('sort-memory')); // 8, 9, 9.5
    expect(rowNames()).toEqual(['Alpha GmbH', 'SYSTEM', 'Bravo Ltd']);
  });
});

describe('TenantsListTab — Change placement / Change plan', () => {
  beforeEach(() => vi.clearAllMocks());

  function selectAll(): void {
    const header = within(screen.getByTestId('tenants-table')).getAllByRole('checkbox')[0];
    fireEvent.click(header);
  }

  it('changes placement of the selected tenants (never SYSTEM) through the bulk runner', () => {
    renderList();
    selectAll();
    fireEvent.click(screen.getByTestId('bulk-change-placement'));
    const modal = screen.getByTestId('bulk-change-placement-modal');
    // Only tenant-capable nodes are offered.
    const options = within(modal).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Choose…', 'node-2']);
    expect(within(modal).getByTestId('bulk-confirm')).toBeDisabled();

    fireEvent.change(within(modal).getByTestId('bulk-change-target'), { target: { value: 'node-2' } });
    fireEvent.click(within(modal).getByTestId('bulk-confirm'));

    expect(start).toHaveBeenCalledTimes(1);
    const config = start.mock.calls[0][0];
    expect(config.title).toBe('Change placement to node-2');
    expect(config.items.map((i: { id: string }) => i.id).sort()).toEqual(['t-1', 't-2']);

    void config.runItem(config.items[0]);
    expect(moveTenantToNodeItem).toHaveBeenCalledWith(config.items[0], { id: 'node-2', label: 'node-2' });
  });

  it('changes the plan, passing the notify choice', () => {
    renderList();
    selectAll();
    fireEvent.click(screen.getByTestId('bulk-change-plan'));
    const modal = screen.getByTestId('bulk-change-plan-modal');
    fireEvent.change(within(modal).getByTestId('bulk-change-target'), { target: { value: 'p-pro' } });
    fireEvent.click(within(modal).getByTestId('bulk-change-notify'));
    fireEvent.click(within(modal).getByTestId('bulk-confirm'));

    const config = start.mock.calls[0][0];
    expect(config.title).toBe('Change plan to Pro');
    const item = config.items.find((i: { id: string }) => i.id === 't-2');
    expect(item).toMatchObject({ planId: 'p-basic', nodeName: 'node-2', misplaced: false });
    void config.runItem(item);
    expect(changeTenantPlanItem).toHaveBeenCalledWith(item, { id: 'p-pro', label: 'Pro' }, false);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { TenantPlacement, TenantPlacementSummary, TenantStorageFailover } from '@insula/api-contracts';
import PlacementCell from '@/components/tenants/PlacementCell';

const hooks = vi.hoisted(() => ({
  placement: { data: undefined as unknown, isLoading: false },
  migrate: {
    mutateAsync: vi.fn(async (_node: string) => ({ data: { currentWorker: 'node-a', deploymentsRestarted: 2 } })),
    isPending: false,
    isSuccess: false,
    error: null as unknown,
    data: undefined as unknown,
  },
}));
vi.mock('@/hooks/use-tenant-placement', () => ({ useTenantPlacement: () => hooks.placement }));
vi.mock('@/hooks/use-tenant-migration', () => ({ useMigrateTenantToWorker: () => hooks.migrate }));

const { default: PlacementStatusPanel } = await import('@/components/tenants/PlacementStatusPanel');

const summary = (over: Partial<TenantPlacementSummary> = {}): TenantPlacementSummary => ({
  status: 'placed', primaryNode: 'node-a', actualNodes: ['node-a'], reasons: [],
  misplacedSince: null, checkedAt: '2026-10-02T09:00:00.000Z', ...over,
});
const misplacedSummary = summary({
  status: 'misplaced', actualNodes: ['node-b'], reasons: ['running on node-b', 'data on node-b'],
  misplacedSince: '2026-10-02T05:10:00.000Z',
});
const full = (s: TenantPlacementSummary, over: Partial<TenantPlacement> = {}): TenantPlacement => ({
  ...s, storageTier: 'local', workloadNodes: s.actualNodes, attachedNodes: s.actualNodes,
  dataNodes: s.actualNodes, ...over,
});
const failover: TenantStorageFailover = {
  id: 'f1', volumeName: 'pvc-1', pvcName: 'tenant-acme-storage', remountRequestedAt: '2026-10-02T05:09:29.000Z',
  nodesBefore: ['node-a'], nodesAfter: ['node-b'], detectedAt: '2026-10-02T05:10:30.000Z',
};
const withPlacement = (placement: TenantPlacement | null, failovers: TenantStorageFailover[] = []) => {
  hooks.placement = { data: { data: { placement, failovers } }, isLoading: false };
};

describe('PlacementCell (tenants table)', () => {
  it('shows the primary node while the tenant is on it', () => {
    render(<PlacementCell nodeName="node-a" placement={summary()} />);
    expect(screen.getByText('node-a')).toBeInTheDocument();
    expect(screen.queryByTestId('placement-misplaced')).toBeNull();
  });

  it('shows where the tenant ACTUALLY is, in red, with the primary underneath', () => {
    render(<PlacementCell nodeName="node-a" placement={misplacedSummary} />);
    const cell = screen.getByTestId('placement-misplaced');
    expect(cell).toHaveTextContent('node-b');
    expect(cell).toHaveTextContent('primary node-a');
    expect(screen.getByText('node-b').className).toMatch(/text-red-600/);
    expect(screen.getByText('node-b').className).toMatch(/dark:text-red-400/);
    expect(cell.getAttribute('title')).toBe('Not on its primary node node-a — running on node-b, data on node-b');
  });

  it('still says "auto" for an unpinned tenant with no placement yet', () => {
    render(<PlacementCell nodeName={null} placement={null} />);
    expect(screen.getByText('auto')).toBeInTheDocument();
  });
});

describe('PlacementStatusPanel (tenant detail)', () => {
  beforeEach(() => {
    hooks.migrate.mutateAsync.mockClear();
    hooks.migrate.error = null;
    hooks.migrate.isSuccess = false;
  });

  it('shows where it runs and keeps its data, with no banner when it is placed', () => {
    withPlacement(full(summary()));
    render(<PlacementStatusPanel tenantId="t1" />);
    expect(screen.getByTestId('placement-summary')).toHaveTextContent('Running onnode-a');
    expect(screen.queryByTestId('placement-misplaced-banner')).toBeNull();
  });

  it('raises the red banner with both ways out when the tenant is misplaced', () => {
    withPlacement(full(misplacedSummary));
    render(<PlacementStatusPanel tenantId="t1" />);
    const banner = screen.getByTestId('placement-misplaced-banner');
    expect(banner).toHaveTextContent('Not on its primary node node-a');
    expect(banner).toHaveTextContent('running on node-b, data on node-b — since 2026-10-02 05:10 UTC');
    expect(screen.getByTestId('placement-move-back')).toHaveTextContent('Move back to node-a');
    expect(screen.getByTestId('placement-make-primary')).toHaveTextContent('Make node-b the primary node');
  });

  it('asks before moving back, says the data will be copied, then re-pins to the primary', async () => {
    withPlacement(full(misplacedSummary));
    render(<PlacementStatusPanel tenantId="t1" />);
    fireEvent.click(screen.getByTestId('placement-move-back'));
    expect(hooks.migrate.mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId('placement-confirm')).toHaveTextContent('Longhorn then copies the tenant\'s data back to node-a');
    fireEvent.click(screen.getByTestId('placement-confirm-button'));
    await waitFor(() => expect(hooks.migrate.mutateAsync).toHaveBeenCalledWith('node-a'));
  });

  it('makes the current node the primary without a data copy', async () => {
    withPlacement(full(misplacedSummary));
    render(<PlacementStatusPanel tenantId="t1" />);
    fireEvent.click(screen.getByTestId('placement-make-primary'));
    expect(screen.getByTestId('placement-confirm')).toHaveTextContent('no data is copied');
    fireEvent.click(screen.getByTestId('placement-confirm-button'));
    await waitFor(() => expect(hooks.migrate.mutateAsync).toHaveBeenCalledWith('node-b'));
  });

  it('cancel backs out without touching anything', () => {
    withPlacement(full(misplacedSummary));
    render(<PlacementStatusPanel tenantId="t1" />);
    fireEvent.click(screen.getByTestId('placement-move-back'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByTestId('placement-confirm')).toBeNull();
    expect(hooks.migrate.mutateAsync).not.toHaveBeenCalled();
  });

  it('offers no "make primary" when the tenant is spread over several nodes', () => {
    withPlacement(full(misplacedSummary, { actualNodes: ['node-b', 'node-c'] }));
    render(<PlacementStatusPanel tenantId="t1" />);
    expect(screen.queryByTestId('placement-make-primary')).toBeNull();
    expect(screen.getByTestId('placement-move-back')).toBeInTheDocument();
  });

  it('lists recent storage failovers with where the tenant went', () => {
    withPlacement(full(misplacedSummary), [failover]);
    render(<PlacementStatusPanel tenantId="t1" />);
    expect(screen.getByTestId('placement-failovers'))
      .toHaveTextContent('2026-10-02 05:09 UTC — volume tenant-acme-storage salvaged and remounted; node-a → node-b');
  });

  it('says it has not been observed yet rather than implying all is well', () => {
    withPlacement(null);
    render(<PlacementStatusPanel tenantId="t1" />);
    expect(screen.getByTestId('placement-status')).toHaveTextContent('Actual placement not observed yet');
  });
});

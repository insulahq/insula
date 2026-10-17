import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ClusterNodeResponse, DrainImpact } from '@insula/api-contracts';
import NodeDrainDeleteModal from '../components/NodeDrainDeleteModal';

// In HA every Postgres instance keeps ONE Longhorn replica, on its own node —
// the other instances are the redundancy. The modal used to list that volume
// as "Last-replica risk" and disable the drain on every server running a
// database instance, though the drain never moves that pod.

let impact: DrainImpact;
vi.mock('@/hooks/use-cluster-nodes', () => ({
  useDrainImpact: () => ({ data: { data: impact }, isLoading: false, error: null, refetch: vi.fn() }),
  useDrainNode: () => ({ mutateAsync: vi.fn(), isPending: false, isSuccess: false, error: null, data: undefined }),
  useDeleteNode: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useClusterNodes: () => ({ data: { data: [] } }),
}));
vi.mock('@/hooks/use-worker-usage', () => ({ useWorkerUsageSummary: () => ({ data: undefined }) }));

type Replica = DrainImpact['longhornReplicas'][number];
const replica = (r: Partial<Replica> & { pvcName: string }): Replica => ({
  volumeName: `pvc-${r.pvcName}`,
  replicaName: `r-${r.pvcName}`,
  isLastReplica: true,
  postgresInstance: null,
  namespace: 'platform',
  tenantId: null,
  tenantName: null,
  ownerLabel: 'Platform System (platform)',
  ...r,
});

function makeImpact(longhornReplicas: Replica[]): DrainImpact {
  return {
    nodeName: 's2',
    alreadyCordoned: false,
    systemPods: [],
    nonSystemPods: [],
    pinnedTenants: [],
    longhornReplicas,
  } as DrainImpact;
}

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <NodeDrainDeleteModal node={{ name: 's2' } as ClusterNodeResponse} onClose={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('NodeDrainDeleteModal — Postgres instances other instances cover', () => {
  beforeEach(() => {
    impact = makeImpact([]);
  });

  it('a covered instance is information, not a last-replica risk — the drain stays enabled', () => {
    impact = makeImpact([replica({
      pvcName: 'system-db-2',
      postgresInstance: { kind: 'postgres', cluster: 'system-db', instance: 'system-db-2', primary: false, coveredBy: ['system-db-1'] },
    })]);
    renderModal();

    expect(screen.queryByText(/Last-replica risk/)).toBeNull();
    expect(screen.queryByTestId('force-last-replica-checkbox')).toBeNull();
    const list = screen.getByTestId('covered-db-instances');
    expect(within(list).getByText('platform/system-db-2')).toBeTruthy();
    expect(within(list).getByText('replica')).toBeTruthy();
    expect(within(list).getByText('data also on system-db-1 (primary)')).toBeTruthy();
    expect((screen.getByTestId('drain-node-s2-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('names the primary and says what its node going down means', () => {
    impact = makeImpact([replica({
      pvcName: 'system-db-1',
      postgresInstance: { kind: 'postgres', cluster: 'system-db', instance: 'system-db-1', primary: true, coveredBy: ['system-db-2', 'system-db-3'] },
    })]);
    renderModal();

    const list = screen.getByTestId('covered-db-instances');
    expect(within(list).getByText('primary')).toBeTruthy();
    expect(within(list).getByText('streaming to system-db-2, system-db-3')).toBeTruthy();
    expect(within(list).getByText(/fails over to a streaming instance/)).toBeTruthy();
  });

  it('an uncovered platform last replica still blocks until "force last replica" is ticked', () => {
    impact = makeImpact([
      replica({ pvcName: 'data-stalwart-mail-0', namespace: 'mail', ownerLabel: 'Platform System (mail)' }),
      replica({
        pvcName: 'system-db-2',
        postgresInstance: { kind: 'postgres', cluster: 'system-db', instance: 'system-db-2', primary: false, coveredBy: ['system-db-1'] },
      }),
    ]);
    renderModal();

    expect(screen.getByText('Last-replica risk (1)')).toBeTruthy();
    expect(screen.getByText('mail/data-stalwart-mail-0')).toBeTruthy();
    expect(screen.getByTestId('force-last-replica-checkbox')).toBeTruthy();
    expect((screen.getByTestId('drain-node-s2-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('an instance nothing covers is a last-replica risk like any other platform volume', () => {
    impact = makeImpact([replica({
      pvcName: 'system-db-1',
      postgresInstance: { kind: 'postgres', cluster: 'system-db', instance: 'system-db-1', primary: true, coveredBy: [] },
    })]);
    renderModal();

    expect(screen.getByText('Last-replica risk (1)')).toBeTruthy();
    expect(screen.queryByTestId('covered-db-instances')).toBeNull();
    expect((screen.getByTestId('drain-node-s2-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a drained node that still holds an instance\'s only copy keeps Delete disabled and says why', () => {
    impact = {
      ...makeImpact([replica({
        pvcName: 'system-db-2',
        postgresInstance: { kind: 'postgres', cluster: 'system-db', instance: 'system-db-2', primary: false, coveredBy: ['system-db-1'] },
      })]),
      alreadyCordoned: true,
    };
    renderModal();

    expect(screen.getByTestId('delete-blocked-database').textContent).toContain('platform/system-db-2');
    expect((screen.getByTestId('delete-node-s2-button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/Node is fully drained/)).toBeNull();
  });

  it('a drained node with no database instance offers Delete as before', () => {
    impact = { ...makeImpact([]), alreadyCordoned: true };
    renderModal();

    expect(screen.queryByTestId('delete-blocked-database')).toBeNull();
    expect(screen.getByText(/Node is fully drained/)).toBeTruthy();
    expect((screen.getByTestId('delete-node-s2-button') as HTMLButtonElement).disabled).toBe(false);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ClusterNodeResponse, DrainImpact } from '@insula/api-contracts';
import NodeDrainDeleteModal from '../components/NodeDrainDeleteModal';

// In HA every Postgres instance keeps ONE Longhorn replica, on its own node —
// the other instances are the redundancy. The modal used to list that volume
// as "Last-replica risk" and disable the drain on every server running a
// database instance, though the drain never moves that pod.

let impact: DrainImpact;
const drainMutate = vi.fn(async (_input: unknown) => ({}));
const deleteMutate = vi.fn(async (_input?: unknown) => ({}));
let clusterNodes: Array<{ name: string; canHostTenantWorkloads: boolean }> = [];
vi.mock('@/hooks/use-cluster-nodes', () => ({
  useDrainImpact: () => ({ data: { data: impact }, isLoading: false, error: null, refetch: vi.fn() }),
  useDrainNode: () => ({ mutateAsync: drainMutate, isPending: false, isSuccess: false, error: null, data: undefined }),
  useDeleteNode: () => ({ mutateAsync: deleteMutate, isPending: false, error: null }),
  useClusterNodes: () => ({ data: { data: clusterNodes } }),
}));
vi.mock('@/hooks/use-worker-usage', () => ({ useWorkerUsageSummary: () => ({ data: undefined }) }));

type Replica = DrainImpact['longhornReplicas'][number];
const replica = (r: Partial<Replica> & { pvcName: string }): Replica => ({
  volumeName: `pvc-${r.pvcName}`,
  replicaName: `r-${r.pvcName}`,
  isLastReplica: true,
  postgresInstance: null,
  movedByRepin: false,
  inUse: true,
  attached: true,
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
    storageFactsComplete: true,
    mailRole: null,
    tenantsDrained: false,
    blocksNewTenants: false,
  } as DrainImpact;
}

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <NodeDrainDeleteModal node={{ name: 's2', role: 'server' } as ClusterNodeResponse} onClose={vi.fn()} />
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

  // Production, after 2026.10.12: the TENANT drain still refused over an
  // unmounted CrowdSec store and a leftover database copy. The drain moves
  // tenants; those volumes stay where they are. Delete asks about them.
  const productionVolumes = () => [
    replica({ pvcName: 'crowdsec-data', namespace: 'crowdsec', ownerLabel: 'Platform System (crowdsec)', attached: false }),
    replica({ pvcName: 'system-db-3', inUse: false, attached: false }),
  ];

  it('platform volumes whose only copy is here never hold the tenant drain back, nor ask to be forced', () => {
    impact = makeImpact(productionVolumes());
    renderModal();

    expect(screen.queryByText(/Last-replica risk/)).toBeNull();
    expect(screen.queryByTestId('force-last-replica-checkbox')).toBeNull();
    expect(screen.queryByTestId('delete-last-copies')).toBeNull();
    expect((screen.getByTestId('drain-node-s2-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('nor does a database instance nothing covers — the drain never moves it', () => {
    impact = makeImpact([replica({
      pvcName: 'system-db-1',
      postgresInstance: { kind: 'postgres', cluster: 'system-db', instance: 'system-db-1', primary: true, coveredBy: [] },
    })]);
    renderModal();

    expect(screen.queryByText(/Last-replica risk/)).toBeNull();
    expect((screen.getByTestId('drain-node-s2-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('Delete lists them as what they are and stays disabled until the operator confirms they may go', async () => {
    impact = { ...makeImpact(productionVolumes()), tenantsDrained: true };
    deleteMutate.mockClear();
    renderModal();

    const panel = screen.getByTestId('delete-last-copies');
    expect(panel.textContent).toContain('crowdsec/crowdsec-data');
    expect(panel.textContent).toContain('— not mounted');
    expect(panel.textContent).toContain('platform/system-db-3');
    expect(panel.textContent).toContain('— leftover, not in use');
    const del = screen.getByTestId('delete-node-s2-button') as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('delete-last-copies-checkbox'));
    expect(del.disabled).toBe(false);
    fireEvent.click(del);
    fireEvent.click(screen.getByTestId('confirm-delete-node-s2-button'));
    await waitFor(() => expect(deleteMutate).toHaveBeenCalledWith({ forceLastReplica: true }));
  });

  it('a drained node that still holds an instance\'s only copy keeps Delete disabled and says why', () => {
    impact = {
      ...makeImpact([replica({
        pvcName: 'system-db-2',
        postgresInstance: { kind: 'postgres', cluster: 'system-db', instance: 'system-db-2', primary: false, coveredBy: ['system-db-1'] },
      })]),
      tenantsDrained: true,
    };
    renderModal();

    expect(screen.getByTestId('delete-blocked-database').textContent).toContain('platform/system-db-2');
    expect((screen.getByTestId('delete-node-s2-button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/Tenants drained — /)).toBeNull();
  });

  it('a drained node with no database instance offers Delete as before', () => {
    impact = { ...makeImpact([]), tenantsDrained: true };
    renderModal();

    expect(screen.queryByTestId('delete-blocked-database')).toBeNull();
    expect(screen.getByText(/Tenants drained — /)).toBeTruthy();
    expect((screen.getByTestId('delete-node-s2-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a tenant that runs nothing, its only copy here, is marked — and Auto says where its data goes', () => {
    const pvc = (detached: boolean) => ({
      pvcName: 'data', volumeName: 'pvc-x', sizeBytes: 1, replicaCount: 1, isLastReplica: true, detached, currentNodeSelector: [],
    });
    const tenant = (id: string, detached: boolean) => ({
      tenantId: id, tenantName: id, namespace: `tenant-${id}`, storageTier: 'local' as const, currentNodeName: 's2',
      workloads: [], pvcs: [pvc(detached)],
    });
    impact = { ...makeImpact([]), pinnedTenants: [tenant('hat', true), tenant('web', false)] };
    renderModal();

    expect(screen.getByTestId('tenant-stopped-hat')).toBeTruthy();
    expect(screen.queryByTestId('tenant-stopped-web')).toBeNull();
    const auto = (id: string) => [...(screen.getByTestId(`tenant-placement-${id}`) as HTMLSelectElement).options]
      .find((o) => o.value === '')?.textContent;
    expect(auto('hat')).toBe('Auto (node with the most free space)');
    expect(auto('web')).toBe('Auto (clear pin)');
    // Tenant volumes are moved by the re-pin — they do not hold the drain back.
    expect((screen.getByTestId('drain-node-s2-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a tenant already pinned to another node keeps it by default — a re-run does not clear an earlier pick', () => {
    clusterNodes = [{ name: 's1', canHostTenantWorkloads: true }, { name: 's3', canHostTenantWorkloads: true }];
    const pvc = { pvcName: 'data', volumeName: 'pvc-x', sizeBytes: 1, replicaCount: 1, isLastReplica: true, detached: true, currentNodeSelector: [] };
    const tenant = (id: string, pin: string) => ({
      tenantId: id, tenantName: id, namespace: `tenant-${id}`, storageTier: 'local' as const, currentNodeName: pin, workloads: [], pvcs: [pvc],
    });
    impact = { ...makeImpact([]), pinnedTenants: [tenant('kept', 's3'), tenant('here', 's2')] };
    renderModal();

    expect((screen.getByTestId('tenant-placement-kept') as HTMLSelectElement).value).toBe('s3');
    expect((screen.getByTestId('tenant-placement-here') as HTMLSelectElement).value).toBe('');
    clusterNodes = [];
  });

  it('a tenant leftover with its only copy here does not hold the drain back either', () => {
    impact = makeImpact([
      replica({ pvcName: 'tenant-b-storage', namespace: 'tenant-b', tenantId: 'b', tenantName: 'B', ownerLabel: 'B', movedByRepin: false, inUse: false }),
    ]);
    renderModal();

    expect((screen.getByTestId('drain-node-s2-button') as HTMLButtonElement).disabled).toBe(false);
  });
});

// The drain moves tenants only. A server stays in service for the platform;
// the dialog asks whether to keep new tenants off (ticked by default) and
// sends that choice; Delete is what moves the system services.
describe('NodeDrainDeleteModal — Drain tenants', () => {
  it('asks to stop new tenants (ticked), sends it, and says system services are not affected', async () => {
    impact = makeImpact([]);
    renderModal();
    const box = screen.getByTestId('drain-block-new-tenants') as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.getByText(/System services are not affected/)).toBeTruthy();
    expect(screen.queryByText(/cordon the node first/i)).toBeNull();
    fireEvent.click(box);
    fireEvent.click(screen.getByTestId('drain-node-s2-button'));
    await waitFor(() => expect(drainMutate).toHaveBeenCalled());
    expect(drainMutate.mock.calls.at(-1)?.[0]).toMatchObject({ blockNewTenants: false });
  });

  it('a node that already keeps tenants off says so instead of asking', () => {
    impact = { ...makeImpact([]), blocksNewTenants: true };
    renderModal();
    expect(screen.queryByTestId('drain-block-new-tenants')).toBeNull();
    expect(screen.getByTestId('drain-already-blocks-tenants')).toBeTruthy();
  });
});


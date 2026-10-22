import { afterEach, describe, expect, it, vi } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { assertTargetHasRoom, migrateTenantToWorker } from './service.js';
import type { Database } from '../../db/index.js';
import type { MovePlan } from './stop-move-start.js';

const GIB = 2 ** 30;
const NS = 'tenant-acme';

/** A cluster whose only volume (100 GiB, 28 GiB used, on node-b) meets a target with `scheduledGiB` already taken. */
function fakeK8s(opts: { scheduledGiB: number; settingsFail?: boolean }): { k8s: K8sClients; reads: string[] } {
  const reads: string[] = [];
  const k8s = {
    custom: {
      listNamespacedCustomObject: async ({ plural }: { plural: string }) => {
        reads.push(`list:${plural}`);
        return plural === 'volumes'
          ? { items: [{ metadata: { name: 'pvc-1' }, spec: { numberOfReplicas: 1, size: String(100 * GIB) }, status: { actualSize: 28 * GIB, kubernetesStatus: { namespace: NS } } }] }
          : { items: [{ spec: { volumeName: 'pvc-1', nodeID: 'node-b' }, status: { currentState: 'running' } }] };
      },
      getNamespacedCustomObject: async ({ plural, name }: { plural: string; name: string }) => {
        reads.push(`get:${plural}:${name}`);
        if (plural === 'nodes') {
          return {
            spec: { disks: { d1: { allowScheduling: true, storageReserved: 45 * GIB } } },
            status: { diskStatus: { d1: { storageMaximum: 150 * GIB, storageAvailable: 128 * GIB, storageScheduled: opts.scheduledGiB * GIB } } },
          };
        }
        if (opts.settingsFail) throw new Error('settings.longhorn.io is forbidden');
        return { value: name === 'storage-over-provisioning-percentage' ? '100' : '15' };
      },
    },
  } as unknown as K8sClients;
  return { k8s, reads };
}

const MOVE: MovePlan = { kind: 'stop-move-start', sourceNodes: ['node-b'] };
const RESTART: MovePlan = { kind: 'restart' };
const move = (plan: MovePlan, consumers: number) => ({ plan, consumers, namespace: NS, target: 'node-a', storageTier: 'local' });

describe('assertTargetHasRoom', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('refuses a running tenant\'s move to a node that cannot hold its volume — 409, with the numbers', async () => {
    const { k8s } = fakeK8s({ scheduledGiB: 39 });
    await expect(assertTargetHasRoom(k8s, move(MOVE, 3))).rejects.toMatchObject({
      code: 'TARGET_NODE_STORAGE_INSUFFICIENT',
      status: 409,
      details: { node_name: 'node-a', needed_bytes: 100 * GIB, schedulable_bytes: 66 * GIB },
    });
    await expect(assertTargetHasRoom(k8s, move(MOVE, 3))).rejects.toThrow(/node-a cannot hold this tenant's 100\.0 GiB volume/);
  });

  it('refuses a STOPPED tenant too: the platform would attach its volume on the target for a copy Longhorn will not make', async () => {
    const { k8s } = fakeK8s({ scheduledGiB: 39 });
    await expect(assertTargetHasRoom(k8s, move(RESTART, 0))).rejects.toMatchObject({ code: 'TARGET_NODE_STORAGE_INSUFFICIENT' });
  });

  it('lets the move through when the volume fits', async () => {
    const { k8s } = fakeK8s({ scheduledGiB: 5 });
    await expect(assertTargetHasRoom(k8s, move(MOVE, 3))).resolves.toBeUndefined();
    await expect(assertTargetHasRoom(k8s, move(RESTART, 0))).resolves.toBeUndefined();
  });

  it('never refuses "make this node the primary" for a tenant already running on it, and does not even ask', async () => {
    const { k8s, reads } = fakeK8s({ scheduledGiB: 39 });
    await expect(assertTargetHasRoom(k8s, move(RESTART, 2))).resolves.toBeUndefined();
    expect(reads).toEqual([]);
  });

  it('moves anyway when the check cannot be made — and says so, instead of passing in silence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { k8s } = fakeK8s({ scheduledGiB: 39, settingsFail: true });
    await expect(assertTargetHasRoom(k8s, move(MOVE, 3))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/could not check that node-a has room for tenant-acme \(settings\.longhorn\.io is forbidden\)/);
  });
});

describe('migrateTenantToWorker — a node that takes pinned tenants only', () => {
  // Reads in order: the tenant, the target node, the target's hosting (HA only).
  const dbFor = (tier: 'local' | 'ha') => {
    const pinnedNode = {
      name: 'za-1', canHostTenantWorkloads: true, labels: { 'insula.host/tenant-placement': 'pinned' },
    };
    const reads = [
      [{ id: 't1', name: 'Acme', storageTier: tier, storageLifecycleState: 'idle', activeStorageOpId: null, nodeName: 'de-1', kubernetesNamespace: NS }],
      [pinnedNode],
      [pinnedNode],
    ];
    let i = 0;
    return { select: () => ({ from: () => ({ where: () => ({ limit: async () => reads[i++] ?? [] }) }) }) } as unknown as Database;
  };

  it('refuses an HA-tier tenant before touching the cluster', async () => {
    const k8s = new Proxy({}, { get: () => { throw new Error('the cluster must not be read'); } }) as unknown as K8sClients;
    await expect(migrateTenantToWorker(dbFor('ha'), k8s, 't1', { nodeName: 'za-1' } as never))
      .rejects.toMatchObject({ code: 'NODE_PINNED_TENANTS_ONLY', status: 409 });
  });

  it('lets a Local-tier tenant past the hosting check', async () => {
    // It goes on to read the cluster — the guard did not stop it.
    const k8s = new Proxy({}, { get: () => { throw new Error('reached the cluster'); } }) as unknown as K8sClients;
    await expect(migrateTenantToWorker(dbFor('local'), k8s, 't1', { nodeName: 'za-1' } as never))
      .rejects.toThrow('reached the cluster');
  });
});

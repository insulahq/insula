import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const { rank, capacity } = vi.hoisted(() => ({ rank: vi.fn(), capacity: vi.fn() }));
vi.mock('../tenants/auto-pick-node.js', () => ({ rankNodesByFreeSpace: rank }));
vi.mock('../tenant-placement/target-capacity.js', () => ({ checkTargetCapacity: capacity }));

import { replicaTarget, resolveAutoTarget } from './auto-target.js';

const ready = (name: string, o: { unschedulable?: boolean; ready?: boolean } = {}) => ({
  metadata: { name },
  spec: { unschedulable: o.unschedulable ?? false },
  status: { conditions: [{ type: 'Ready', status: o.ready === false ? 'False' : 'True' }] },
});

/** A cluster whose tenant volume has its replicas on `replicaNodes`. */
function cluster(o: { replicaNodes: string[]; nodes?: ReturnType<typeof ready>[]; failNodeList?: boolean }) {
  return {
    core: {
      listNode: async () => {
        if (o.failNodeList) throw new Error('API down');
        return { items: o.nodes ?? [] };
      },
      readNamespacedPersistentVolumeClaim: async () => ({ spec: { volumeName: 'pvc-1' } }),
    },
    custom: {
      getNamespacedCustomObject: async () => ({ spec: { size: '400' } }),
      listNamespacedCustomObject: async () => ({
        items: o.replicaNodes.map((nodeID) => ({ spec: { nodeID }, status: { currentState: 'running' } })),
      }),
    },
  } as unknown as K8sClients;
}
const db = {} as Database;
const ARGS = { namespace: 'tenant-acme', volumeNames: ['pvc-1'], releaseFrom: 'sv2', storageTier: 'local' };

beforeEach(() => {
  rank.mockReset();
  capacity.mockReset().mockResolvedValue({ state: 'ok' });
});

describe('replicaTarget', () => {
  it('takes the roomiest eligible node that holds a copy', () => {
    expect(replicaTarget(['sv4', 'sv3', 'sv1'], ['sv1', 'sv3'])).toBe('sv3');
    expect(replicaTarget(['sv4'], ['sv2'])).toBeNull();
  });
});

describe('resolveAutoTarget', () => {
  it('keeps the pods on the node already holding the data — the drained tenant on production', async () => {
    // Pods on sv2 (being drained), the only copy on sv3: sending them to sv3 copies nothing.
    rank.mockResolvedValue([{ name: 'sv4', freeBytes: 900 }, { name: 'sv3', freeBytes: 500 }, { name: 'sv1', freeBytes: 100 }]);
    const choice = await resolveAutoTarget(cluster({ replicaNodes: ['sv3'] }), db, ARGS);
    expect(choice).toEqual({ node: 'sv3', source: 'replica' });
    expect(capacity).not.toHaveBeenCalled();
  });

  it('never ranks the node being left, a cordoned one or one that is not Ready', async () => {
    rank.mockResolvedValue([{ name: 'sv4', freeBytes: 900 }]);
    await resolveAutoTarget(cluster({
      replicaNodes: ['sv2'],
      nodes: [ready('sv1', { unschedulable: true }), ready('sv3', { ready: false }), ready('sv4')],
    }), db, ARGS);
    const exclude = rank.mock.calls[0]![2].exclude as Set<string>;
    expect([...exclude].sort()).toEqual(['sv1', 'sv2', 'sv3']);
  });

  it('with the only copy on the node being left, takes the roomiest node that can take the volume', async () => {
    rank.mockResolvedValue([{ name: 'sv4', freeBytes: 900 }, { name: 'sv3', freeBytes: 500 }]);
    capacity.mockImplementation(async (_k, _ns, node: string) =>
      node === 'sv4' ? { state: 'insufficient', detail: 'full' } : { state: 'ok' });
    const choice = await resolveAutoTarget(cluster({ replicaNodes: ['sv2'] }), db, ARGS);
    expect(choice).toEqual({ node: 'sv3', source: 'free-space' });
  });

  it('gives no node when nothing fits or nothing can be ranked — the caller clears the pin as before', async () => {
    rank.mockResolvedValue([{ name: 'sv4', freeBytes: 900 }]);
    capacity.mockResolvedValue({ state: 'insufficient', detail: 'full' });
    expect(await resolveAutoTarget(cluster({ replicaNodes: ['sv2'] }), db, ARGS)).toEqual({ node: null, source: null });
    rank.mockResolvedValue(null);
    expect(await resolveAutoTarget(cluster({ replicaNodes: ['sv3'] }), db, ARGS)).toEqual({ node: null, source: null });
  });

  it('spreads the tenants of one drain by the data it already sends to each node', async () => {
    // sv4 has 100 more bytes free than sv3; the first 400-byte tenant uses that up.
    rank.mockResolvedValue([{ name: 'sv4', freeBytes: 1000 }, { name: 'sv3', freeBytes: 900 }]);
    const planned = new Map<string, number>();
    const first = await resolveAutoTarget(cluster({ replicaNodes: ['sv2'] }), db, { ...ARGS, planned });
    const second = await resolveAutoTarget(cluster({ replicaNodes: ['sv2'] }), db, { ...ARGS, planned });
    expect([first.node, second.node]).toEqual(['sv4', 'sv3']);
    expect(planned).toEqual(new Map([['sv4', 400], ['sv3', 400]]));
  });

  it('picks no node when the node list cannot be read — a cordoned or NotReady one could not be told apart', async () => {
    rank.mockResolvedValue([{ name: 'sv4', freeBytes: 900 }]);
    expect(await resolveAutoTarget(cluster({ replicaNodes: ['sv4'], failNodeList: true }), db, ARGS))
      .toEqual({ node: null, source: null });
    expect(rank).not.toHaveBeenCalled();
  });

  it('holds only the Local tier to one node — HA, or a tier it was not told', async () => {
    for (const storageTier of ['ha', null]) {
      expect(await resolveAutoTarget(cluster({ replicaNodes: ['sv3'] }), db, { ...ARGS, storageTier }))
        .toEqual({ node: null, source: null });
    }
    expect(rank).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  copyRefusalText, explainCopyRefusal, readCopyBlocker, readCopyRefusalContext, refusedVolumeOf,
  type CopyRefusalContext, type RefusedVolume,
} from './copy-refusal.js';
import type { LhNodeRaw } from './target-capacity.js';

const GIB = 2 ** 30;
const NS = 'tenant-acme-1234';
const WORDS = 'replica scheduling failed';
// Longhorn's defaults.
const SETTINGS = { overProvisioningPct: 100, minimalAvailablePct: 25 };

const disk = (over: { maximum?: number; available?: number; scheduled?: number; tags?: string[]; allowScheduling?: boolean } = {}) => ({
  spec: { allowScheduling: over.allowScheduling ?? true, storageReserved: 0, tags: over.tags ?? [] },
  status: {
    storageMaximum: (over.maximum ?? 675) * GIB,
    storageAvailable: (over.available ?? 595) * GIB,
    storageScheduled: (over.scheduled ?? 221) * GIB,
    conditions: [{ type: 'Ready', status: 'True' }],
  },
});
const lhNode = (name: string, opts: { tags?: string[]; allowScheduling?: boolean; disks?: Record<string, ReturnType<typeof disk>> } = {}): LhNodeRaw => {
  const disks = opts.disks ?? { d1: disk() };
  return {
    metadata: { name },
    spec: {
      allowScheduling: opts.allowScheduling ?? true,
      tags: opts.tags ?? ['system'],
      disks: Object.fromEntries(Object.entries(disks).map(([k, d]) => [k, d.spec])),
    },
    status: {
      conditions: [{ type: 'Ready', status: 'True' }, { type: 'Schedulable', status: 'True' }],
      diskStatus: Object.fromEntries(Object.entries(disks).map(([k, d]) => [k, d.status])),
    },
  };
};
const ctx = (...nodes: LhNodeRaw[]): CopyRefusalContext => ({
  nodes: new Map(nodes.map((n) => [n.metadata!.name!, n])),
  settings: SETTINGS,
  emptySelector: { node: true, disk: true },
});
const volume = (over: Partial<RefusedVolume> = {}): RefusedVolume => ({
  nodeSelector: [], diskSelector: [], size: 50 * GIB, actualSize: 28 * GIB, ...over,
});

describe('explainCopyRefusal', () => {
  it('names the node tag a drain left on the volume, not room, on a node with room to spare', () => {
    // Production: drained onto node-a (tag node-node-a), later moved to node-b with 595 GB free.
    const r = explainCopyRefusal('node-b', volume({ nodeSelector: ['node-node-a'] }), ctx(lhNode('node-a', { tags: ['node-node-a', 'system'] }), lhNode('node-b')), WORDS);
    expect(r.cause).toBe('the volume is still held to the Longhorn node tagged node-node-a (a pin left by an earlier drain or move), '
      + 'and node-b does not carry that tag');
    expect(r.action).toBe('move the tenant again from its Placement card; a move holds the volume to the node it moves to');
    expect(copyRefusalText(r)).not.toMatch(/room|shrink/);
  });

  it('names a tag set by hand, and says where to fix it', () => {
    const r = explainCopyRefusal('node-b', volume({ nodeSelector: ['ssd', 'system'] }), ctx(lhNode('node-b')), WORDS);
    expect(r.cause).toBe('the volume may only use Longhorn nodes tagged ssd, system, and node-b is not tagged ssd');
    expect(r.action).toBe('add the tag to node-b in Longhorn, or remove it from the volume');
  });

  it('passes a node selector the target meets on to the next check', () => {
    const r = explainCopyRefusal('node-b', volume({ nodeSelector: ['node-node-b'] }), ctx(lhNode('node-b', { tags: ['node-node-b'] })), WORDS);
    expect(r.cause).toBe(`Longhorn: ${WORDS}`);
  });

  it('says when Longhorn has no node by that name', () => {
    expect(explainCopyRefusal('node-x', volume(), ctx(lhNode('node-b')), WORDS).cause).toBe('Longhorn has no node named node-x');
  });

  it('says when scheduling is switched off on the node or on all of its disks', () => {
    const off = 'Longhorn scheduling is switched off on node-b or on all of its disks';
    expect(explainCopyRefusal('node-b', volume(), ctx(lhNode('node-b', { allowScheduling: false })), WORDS).cause).toBe(off);
    expect(explainCopyRefusal('node-b', volume(), ctx(lhNode('node-b', { disks: { d1: disk({ allowScheduling: false }) } })), WORDS).cause).toBe(off);
  });

  it('passes on why Longhorn says a disk is not ready, and does not promise that waiting fixes it', () => {
    // Lab staging: a disk whose filesystem changed under Longhorn.
    const node = lhNode('node-b');
    const broken: LhNodeRaw = {
      ...node,
      status: {
        ...node.status,
        diskStatus: { d1: { storageMaximum: 0, storageAvailable: 0, storageScheduled: 0, conditions: [{
          type: 'Ready', status: 'False',
          message: 'Disk default-disk-1(/var/lib/longhorn/) on node node-b is not ready: record diskUUID doesn\'t match the one on the disk ',
        }] } },
      },
    };
    const r = explainCopyRefusal('node-b', volume(), ctx(broken), WORDS);
    expect(r.cause).toBe('node-b\'s Longhorn disk is not ready: Disk default-disk-1(/var/lib/longhorn/) on node node-b is not ready: '
      + 'record diskUUID doesn\'t match the one on the disk');
    expect(r.action).toBe('a node that only just joined gets there by itself; otherwise fix the disk on node-b in Longhorn, '
      + 'or move the tenant to another node');
  });

  it('names a disk tag no disk on the node has', () => {
    const r = explainCopyRefusal('node-b', volume({ diskSelector: ['nvme'] }), ctx(lhNode('node-b', { disks: { d1: disk({ tags: ['system'] }) } })), WORDS);
    expect(r.cause).toBe('the volume may only use Longhorn disks tagged nvme, and no disk on node-b has it');
    expect(r.action).toBe('tag a disk on node-b in Longhorn, or remove the tag from the volume');
  });

  it('says room is short only when it is, with the numbers Longhorn uses', () => {
    // Production, earlier: a 100 GiB volume holding 28 GiB, 66 GiB left to schedule.
    const full = lhNode('node-b', { disks: { d1: disk({ maximum: 200, available: 150, scheduled: 134 }) } });
    const r = explainCopyRefusal('node-b', volume({ size: 100 * GIB }), ctx(full), WORDS);
    expect(r.cause).toBe('node-b has 66.0 GiB left that Longhorn will schedule, and Longhorn reserves the volume\'s full 100.0 GiB, '
      + 'not the 28.0 GiB in use');
    expect(r.action).toBe('move the tenant to a node with more room, or shrink the volume');
  });

  it('says when the copy would take the disk below Longhorn\'s free-space floor', () => {
    const low = lhNode('node-b', { disks: { d1: disk({ maximum: 100, available: 30, scheduled: 0 }) } });
    const r = explainCopyRefusal('node-b', volume({ size: 10 * GIB, actualSize: 10 * GIB }), ctx(low), WORDS);
    expect(r.cause).toBe('copying its 10.0 GiB would take node-b\'s disk below Longhorn\'s free-space floor (25% of the disk)');
  });

  it('judges room only on the disks the volume may use', () => {
    const node = lhNode('node-b', {
      disks: { big: disk({ tags: [] }), tagged: disk({ maximum: 200, available: 150, scheduled: 134, tags: ['nvme'] }) },
    });
    expect(explainCopyRefusal('node-b', volume({ size: 100 * GIB, diskSelector: ['nvme'] }), ctx(node), WORDS).cause)
      .toMatch(/^node-b has 66\.0 GiB left/);
  });

  it('names Longhorn\'s empty-selector settings when they keep an untagged volume off a tagged node or disk', () => {
    const strictNode = { ...ctx(lhNode('node-b')), emptySelector: { node: false, disk: true } };
    expect(explainCopyRefusal('node-b', volume(), strictNode, WORDS).cause).toBe('the volume has no node tags, and with Longhorn\'s '
      + 'allow-empty-node-selector-volume setting off it may not use node-b, which is tagged system');
    const strictDisk = { ...ctx(lhNode('node-b', { disks: { d1: disk({ tags: ['system'] }) } })), emptySelector: { node: true, disk: false } };
    expect(explainCopyRefusal('node-b', volume(), strictDisk, WORDS).cause).toBe('the volume has no disk tags, and with Longhorn\'s '
      + 'allow-empty-disk-selector-volume setting off it may not use node-b\'s disks, which are all tagged');
    // An untagged disk is still open to it.
    const mixed = { ...ctx(lhNode('node-b', { disks: { t: disk({ tags: ['system'] }), u: disk() } })), emptySelector: { node: true, disk: false } };
    expect(explainCopyRefusal('node-b', volume(), mixed, WORDS).cause).toBe(`Longhorn: ${WORDS}`);
  });

  it('does not claim every check allows the copy when the empty-selector settings were not read', () => {
    const unread = { ...ctx(lhNode('node-b')), emptySelector: { node: null, disk: true } };
    expect(explainCopyRefusal('node-b', volume(), unread, WORDS).action).toBe('look at the volume in the Longhorn UI');
  });

  it('passes Longhorn\'s words on when every check here allows the copy, and says so', () => {
    const r = explainCopyRefusal('node-b', volume(), ctx(lhNode('node-b')), WORDS);
    expect(r).toEqual({
      cause: `Longhorn: ${WORDS}`,
      action: 'node-b, its disks and the volume\'s tags all allow the copy, so look at the volume in the Longhorn UI',
    });
  });

  it('guesses nothing when Longhorn could not be read', () => {
    expect(explainCopyRefusal('node-b', volume({ nodeSelector: ['node-node-a'] }), null, WORDS))
      .toEqual({ cause: `Longhorn: ${WORDS}`, action: 'look at the volume in the Longhorn UI' });
    // Tags readable, settings not: room is not judged, and not claimed to be fine.
    const noSettings = { ...ctx(lhNode('node-b', { disks: { d1: disk({ maximum: 200, available: 150, scheduled: 134 }) } })), settings: null };
    expect(explainCopyRefusal('node-b', volume({ size: 100 * GIB }), noSettings, WORDS).action).toBe('look at the volume in the Longhorn UI');
  });
});

describe('refusedVolumeOf', () => {
  it('reads tags and sizes, with Longhorn\'s byte strings', () => {
    expect(refusedVolumeOf({ spec: { size: '53687091200', nodeSelector: ['node-node-a'], diskSelector: null }, status: { actualSize: 30244999168 } }))
      .toEqual({ nodeSelector: ['node-node-a'], diskSelector: [], size: 53687091200, actualSize: 30244999168 });
    expect(refusedVolumeOf({})).toEqual({ nodeSelector: [], diskSelector: [], size: 0, actualSize: 0 });
  });
});

function fakeK8s(lists: Record<string, unknown[]>, settings: Record<string, string> = {
  'storage-over-provisioning-percentage': '100', 'storage-minimal-available-percentage': '25',
  'allow-empty-node-selector-volume': 'true', 'allow-empty-disk-selector-volume': 'true',
}) {
  return {
    custom: {
      listNamespacedCustomObject: async (a: { plural: string }) => ({ items: lists[a.plural] ?? [] }),
      getNamespacedCustomObject: async (a: { plural: string; name: string }) => {
        if (a.plural !== 'settings' || !(a.name in settings)) throw new Error(`${a.plural}/${a.name} not found`);
        return { value: settings[a.name] };
      },
    },
  } as unknown as K8sClients;
}

describe('readCopyBlocker', () => {
  const refused = [{ type: 'Scheduled', status: 'False', reason: 'LocalReplicaSchedulingFailure', message: WORDS }];
  const lhVol = (over: Record<string, unknown> = {}, status: Record<string, unknown> = {}) => ({
    metadata: { name: 'pvc-1' }, spec: { numberOfReplicas: 1, size: String(50 * GIB) },
    status: { actualSize: 28 * GIB, conditions: refused, kubernetesStatus: { namespace: NS, lastPVCRefAt: '' }, ...status }, ...over,
  });
  const lhRep = (nodeID: string, over: Record<string, unknown> = {}) => ({
    spec: { volumeName: 'pvc-1', nodeID }, status: { currentState: 'running' }, ...over,
  });
  const nodes = [lhNode('node-a'), lhNode('node-b', { tags: ['node-node-b', 'system'] })];
  const read = (volumes: unknown[], replicas: unknown[], tier: string | null = 'local') =>
    readCopyBlocker(fakeK8s({ volumes, replicas, nodes }), NS, 'node-a', tier);

  it('explains the refusal of a moved volume that has nothing on the target', async () => {
    const held = lhVol({ spec: { numberOfReplicas: 1, size: String(50 * GIB), nodeSelector: ['node-node-b'] } });
    expect((await read([held], [lhRep('node-b')]))?.cause).toMatch(/^the volume is still held to the Longhorn node tagged node-node-b/);
    // A failed or errored replica on the target is not a copy there.
    expect(await read([held], [lhRep('node-b'), lhRep('node-a', { spec: { volumeName: 'pvc-1', nodeID: 'node-a', failedAt: '2026-10-13T10:36:15Z' } })]))
      .not.toBeNull();
    expect(await read([held], [lhRep('node-b'), lhRep('node-a', { status: { currentState: 'error' } })])).not.toBeNull();
  });

  it('is null when scheduling is fine', async () => {
    expect(await read([lhVol({}, { conditions: [{ type: 'Scheduled', status: 'True' }] })], [lhRep('node-b')])).toBeNull();
    expect(await read([lhVol({}, { conditions: undefined })], [lhRep('node-b')])).toBeNull();
  });

  it('does not report a Scheduled=False that is not about this move', async () => {
    // Data already on the target; replicated by design; HA tier; another
    // tenant's volume; a leftover of a past PVC.
    expect(await read([lhVol()], [lhRep('node-a')])).toBeNull();
    expect(await read([lhVol({ spec: { numberOfReplicas: 3 } })], [lhRep('node-b')])).toBeNull();
    expect(await read([lhVol()], [lhRep('node-b')], 'ha')).toBeNull();
    expect(await read([lhVol({}, { kubernetesStatus: { namespace: 'tenant-other' } })], [lhRep('node-b')])).toBeNull();
    expect(await read([lhVol({}, { kubernetesStatus: { namespace: NS, lastPVCRefAt: '2026-09-01T00:00:00Z' } })], [lhRep('node-b')])).toBeNull();
  });

  it('with namedOnly, reports only a cause read from the cluster now — not Longhorn\'s possibly stale words', async () => {
    // Right after a re-pin the condition can still describe the volume as it was.
    const k8s = fakeK8s({ volumes: [lhVol()], replicas: [lhRep('node-b')], nodes });
    expect(await readCopyBlocker(k8s, NS, 'node-a', 'local', { namedOnly: true })).toBeNull();
    expect((await readCopyBlocker(k8s, NS, 'node-a', 'local'))?.cause).toBe(`Longhorn: ${WORDS}`);
    const tagged = lhVol({ spec: { numberOfReplicas: 1, size: String(50 * GIB), diskSelector: ['nvme'] } });
    expect((await readCopyBlocker(fakeK8s({ volumes: [tagged], replicas: [lhRep('node-b')], nodes }), NS, 'node-a', 'local', { namedOnly: true }))?.cause)
      .toMatch(/^the volume may only use Longhorn disks tagged nvme/);
  });

  it('never throws: an unreadable cluster words nothing', async () => {
    const k8s = { custom: { listNamespacedCustomObject: async () => { throw new Error('forbidden'); } } } as unknown as K8sClients;
    expect(await readCopyBlocker(k8s, NS, 'node-a', 'local')).toBeNull();
  });
});

describe('readCopyRefusalContext', () => {
  it('reads Longhorn\'s nodes by name and its two scheduling settings', async () => {
    const c = await readCopyRefusalContext(fakeK8s({ nodes: [lhNode('node-b')] }));
    expect([...(c?.nodes.keys() ?? [])]).toEqual(['node-b']);
    expect(c?.settings).toEqual(SETTINGS);
    expect(c?.emptySelector).toEqual({ node: true, disk: true });
  });

  it('leaves room unjudged when a setting cannot be read, and gives null when the nodes cannot', async () => {
    expect((await readCopyRefusalContext(fakeK8s({ nodes: [lhNode('node-b')] }, {})))?.settings).toBeNull();
    const k8s = { custom: { listNamespacedCustomObject: async () => { throw new Error('forbidden'); } } } as unknown as K8sClients;
    expect(await readCopyRefusalContext(k8s)).toBeNull();
  });
});

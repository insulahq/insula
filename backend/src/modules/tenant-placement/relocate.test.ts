import { describe, expect, it } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { ReplicaFact } from '../tenant-health/service.js';
import {
  RELOCATE_MAX_MS,
  RELOCATE_STARTED_ANNOTATION,
  RELOCATE_TICKET,
  finishDataRelocations,
  planRelocation,
  releaseRelocationsInNamespace,
  relocationVerdict,
  startDataRelocation,
  type RelocationVolume,
} from './relocate.js';

const NS = 'tenant-acme-1234';
const vol = (over: Partial<RelocationVolume> = {}): RelocationVolume => ({
  volumeName: 'pvc-1', namespace: NS, pvcRefLostAt: null, inUse: false, replicaCount: 1,
  relocatingTo: null, otherTickets: false, ...over,
});
const rep = (nodeId: string, over: Partial<ReplicaFact> = {}): ReplicaFact => ({
  volumeName: 'pvc-1', nodeId, running: false, failed: false, ...over,
});

describe('planRelocation', () => {
  it('attaches a detached volume whose only copy is on another node', () => {
    expect(planRelocation([vol()], [rep('node-b')], NS, 'node-a', 'local'))
      .toEqual({ attach: ['pvc-1'], skipped: [] });
  });

  it('leaves a volume that already has a copy on the target', () => {
    expect(planRelocation([vol()], [rep('node-a')], NS, 'node-a', 'local').skipped)
      .toEqual([{ volumeName: 'pvc-1', reason: 'already-local' }]);
  });

  it('a failed replica on the target is not a copy', () => {
    expect(planRelocation([vol()], [rep('node-a', { failed: true }), rep('node-b')], NS, 'node-a', 'local').attach)
      .toEqual(['pvc-1']);
  });

  it('leaves a volume a workload (or the fsck) has attached to that workload', () => {
    expect(planRelocation([vol({ inUse: true, otherTickets: true })], [rep('node-b')], NS, 'node-a', 'local').skipped)
      .toEqual([{ volumeName: 'pvc-1', reason: 'in-use' }]);
  });

  it('re-targets a volume held only by its own earlier relocation to another node', () => {
    // Move back to node-b, then — before the copy finished — to node-a.
    expect(planRelocation([vol({ inUse: true, relocatingTo: 'node-b' })], [rep('node-b'), rep('node-c')], NS, 'node-a', 'local').attach)
      .toEqual(['pvc-1']);
    // …but not when a workload holds it too.
    expect(planRelocation([vol({ inUse: true, relocatingTo: 'node-b', otherTickets: true })], [rep('node-c')], NS, 'node-a', 'local').skipped)
      .toEqual([{ volumeName: 'pvc-1', reason: 'in-use' }]);
  });

  it('never moves a volume that really carries several replicas, whatever the tier says', () => {
    expect(planRelocation([vol({ replicaCount: 2 })], [rep('node-b'), rep('node-c')], NS, 'node-a', 'local').skipped)
      .toEqual([{ volumeName: 'pvc-1', reason: 'ha-tier' }]);
  });

  it('never moves an HA tenant, another namespace, or a leftover volume', () => {
    expect(planRelocation([vol()], [rep('node-b')], NS, 'node-a', 'ha').skipped)
      .toEqual([{ volumeName: 'pvc-1', reason: 'ha-tier' }]);
    expect(planRelocation([vol({ namespace: 'tenant-other' })], [rep('node-b')], NS, 'node-a', 'local'))
      .toEqual({ attach: [], skipped: [] });
    expect(planRelocation([vol({ pvcRefLostAt: '2026-10-01T00:00:00Z' })], [rep('node-b')], NS, 'node-a', 'local'))
      .toEqual({ attach: [], skipped: [] });
  });
});

describe('relocationVerdict', () => {
  const start = new Date('2026-10-03T17:00:00Z');
  const soon = new Date(start.getTime() + 60_000);

  it('is done only when a RUNNING copy is on the target and no other copy is left', () => {
    expect(relocationVerdict([rep('node-a', { running: true })], 'pvc-1', 'node-a', start, soon)).toBe('done');
    // Rebuilding into it: exists, not running yet.
    expect(relocationVerdict([rep('node-a'), rep('node-b', { running: true })], 'pvc-1', 'node-a', start, soon)).toBe('waiting');
    // Local copy done, remote not dropped yet.
    expect(relocationVerdict([rep('node-a', { running: true }), rep('node-b', { running: true })], 'pvc-1', 'node-a', start, soon)).toBe('waiting');
    // A failed leftover elsewhere does not hold it up.
    expect(relocationVerdict([rep('node-a', { running: true }), rep('node-b', { failed: true })], 'pvc-1', 'node-a', start, soon)).toBe('done');
  });

  it('gives up after the time limit, or at once when nobody can date the ticket', () => {
    const late = new Date(start.getTime() + RELOCATE_MAX_MS + 1);
    expect(relocationVerdict([rep('node-b', { running: true })], 'pvc-1', 'node-a', start, late)).toBe('timed-out');
    expect(relocationVerdict([rep('node-b', { running: true })], 'pvc-1', 'node-a', null, soon)).toBe('timed-out');
  });
});

/** A Longhorn that answers lists and records merge patches. */
function fakeK8s(lists: Record<string, unknown[]>) {
  const patches: Array<{ plural: string; name: string; body: unknown }> = [];
  const k8s = {
    custom: {
      listNamespacedCustomObject: async (a: { plural: string }) => ({ items: lists[a.plural] ?? [] }),
      patchNamespacedCustomObject: async (a: { plural: string; name: string; body: unknown }) => {
        patches.push({ plural: a.plural, name: a.name, body: a.body });
        return {};
      },
    },
  } as unknown as K8sClients;
  return { k8s, patches };
}

describe('startDataRelocation', () => {
  it('puts an attachment ticket for the target, dated, on each volume to move', async () => {
    const { k8s, patches } = fakeK8s({
      volumes: [
        { metadata: { name: 'pvc-1' }, status: { state: 'detached', currentNodeID: '', kubernetesStatus: { namespace: NS, pvcName: 's', lastPVCRefAt: '' } } },
        { metadata: { name: 'pvc-other' }, status: { state: 'detached', kubernetesStatus: { namespace: 'tenant-other' } } },
      ],
      replicas: [{ spec: { volumeName: 'pvc-1', nodeID: 'node-b' }, status: { currentState: 'stopped' } }],
    });
    const now = new Date('2026-10-03T17:00:00Z');
    const res = await startDataRelocation(k8s, NS, 'node-a', 'local', now);
    expect(res).toEqual({ started: ['pvc-1'], skipped: [], error: null });
    expect(patches).toEqual([{
      plural: 'volumeattachments',
      name: 'pvc-1',
      body: {
        metadata: { annotations: { [RELOCATE_STARTED_ANNOTATION]: now.toISOString() } },
        spec: { attachmentTickets: { [RELOCATE_TICKET]: {
          id: RELOCATE_TICKET, type: 'longhorn-api', nodeID: 'node-a',
          parameters: { disableFrontend: 'false', lastAttachedBy: '' },
        } } },
      },
    }]);
  });

  it('reports a failure instead of throwing — the re-pin already happened', async () => {
    const k8s = { custom: { listNamespacedCustomObject: async () => { throw new Error('forbidden'); } } } as unknown as K8sClients;
    expect(await startDataRelocation(k8s, NS, 'node-a', 'local')).toEqual({ started: [], skipped: [], error: 'forbidden' });
  });

  it('one volume failing does not stop the others', async () => {
    const detached = (name: string) => ({ metadata: { name }, status: { state: 'detached', kubernetesStatus: { namespace: NS } } });
    const k8s = {
      custom: {
        listNamespacedCustomObject: async (a: { plural: string }) => ({
          items: a.plural === 'volumes' ? [detached('pvc-1'), detached('pvc-2')]
            : a.plural === 'replicas' ? [{ spec: { volumeName: 'pvc-1', nodeID: 'node-b' } }, { spec: { volumeName: 'pvc-2', nodeID: 'node-b' } }]
              : [],
        }),
        patchNamespacedCustomObject: async (a: { name: string }) => {
          if (a.name === 'pvc-1') throw new Error('conflict');
          return {};
        },
      },
    } as unknown as K8sClients;
    expect(await startDataRelocation(k8s, NS, 'node-a', 'local')).toEqual({ started: ['pvc-2'], skipped: [], error: 'pvc-1: conflict' });
  });
});

describe('finishDataRelocations', () => {
  const start = '2026-10-03T17:00:00.000Z';
  const va = (name: string, node: string) => ({
    metadata: { name, annotations: { [RELOCATE_STARTED_ANNOTATION]: start } },
    spec: { attachmentTickets: { [RELOCATE_TICKET]: { nodeID: node }, 'csi-abc': { nodeID: node } } },
  });

  it('releases only finished relocations, and only its own ticket', async () => {
    const { k8s, patches } = fakeK8s({
      volumeattachments: [va('pvc-done', 'node-a'), va('pvc-busy', 'node-a'), { metadata: { name: 'pvc-csi' }, spec: { attachmentTickets: { 'csi-x': { nodeID: 'node-b' } } } }],
    });
    const replicas: ReplicaFact[] = [
      { volumeName: 'pvc-done', nodeId: 'node-a', running: true, failed: false },
      { volumeName: 'pvc-busy', nodeId: 'node-a', running: false, failed: false },
      { volumeName: 'pvc-busy', nodeId: 'node-b', running: true, failed: false },
    ];
    const released = await finishDataRelocations(k8s, replicas, new Date('2026-10-03T17:05:00Z'));
    expect(released).toEqual([{ volumeName: 'pvc-done', node: 'node-a', verdict: 'done' }]);
    expect(patches).toEqual([{
      plural: 'volumeattachments',
      name: 'pvc-done',
      body: {
        metadata: { annotations: { [RELOCATE_STARTED_ANNOTATION]: null } },
        spec: { attachmentTickets: { [RELOCATE_TICKET]: null } },
      },
    }]);
  });
});

describe('releaseRelocationsInNamespace', () => {
  it('drops our ticket from the namespace\'s volumes only — a storage operation needs them detached', async () => {
    const { k8s, patches } = fakeK8s({
      volumes: [
        { metadata: { name: 'pvc-1' }, status: { kubernetesStatus: { namespace: NS } } },
        { metadata: { name: 'pvc-other' }, status: { kubernetesStatus: { namespace: 'tenant-other' } } },
      ],
      volumeattachments: [
        { metadata: { name: 'pvc-1' }, spec: { attachmentTickets: { [RELOCATE_TICKET]: { nodeID: 'node-a' } } } },
        { metadata: { name: 'pvc-other' }, spec: { attachmentTickets: { [RELOCATE_TICKET]: { nodeID: 'node-a' } } } },
      ],
    });
    expect(await releaseRelocationsInNamespace(k8s, NS)).toEqual(['pvc-1']);
    expect(patches.map((p) => p.name)).toEqual(['pvc-1']);
  });

  it('never throws — the storage operation reports its own detach wait', async () => {
    const k8s = { custom: { listNamespacedCustomObject: async () => { throw new Error('down'); } } } as unknown as K8sClients;
    expect(await releaseRelocationsInNamespace(k8s, NS)).toEqual([]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  diskStatusFixFor,
  planLonghornNodeReap,
  reapLonghornNode,
  reapOrphanLonghornNodes,
  type LonghornNodeShape,
} from './longhorn-node-reap.js';

function lhNode(name: string, ready: { status: string; reason?: string }, allowScheduling = true): LonghornNodeShape {
  return {
    metadata: { name },
    spec: { allowScheduling },
    status: { conditions: [{ type: 'Ready', ...ready }] },
  };
}
const GONE = { status: 'False', reason: 'KubernetesNodeGone' };
const UP = { status: 'True', reason: '' };

function httpError(code: number): Error {
  return Object.assign(new Error(`HTTP ${code}`), { code });
}

describe('planLonghornNodeReap', () => {
  const live = new Set(['s1', 's2']);

  it('plans a Longhorn node whose Kubernetes node is gone and that Longhorn reports gone', () => {
    expect(planLonghornNodeReap([lhNode('s1', UP), lhNode('w1', GONE)], live, new Set()))
      .toEqual([{ name: 'w1', allowScheduling: true, diskStatusFix: null }]);
  });

  it('accepts ManagerPodMissing as Longhorn seeing the node go', () => {
    const plan = planLonghornNodeReap([lhNode('w1', { status: 'False', reason: 'ManagerPodMissing' })], live, new Set());
    expect(plan.map((c) => c.name)).toEqual(['w1']);
  });

  it('never plans a live node, whatever Longhorn says', () => {
    expect(planLonghornNodeReap([lhNode('s2', GONE)], live, new Set())).toEqual([]);
  });

  it('waits while Longhorn still sees the node Ready (the host still runs right after Delete)', () => {
    expect(planLonghornNodeReap([lhNode('w1', UP)], live, new Set())).toEqual([]);
  });

  it('waits for a not-Ready reason other than the node being gone', () => {
    expect(planLonghornNodeReap([lhNode('w1', { status: 'False', reason: 'KubernetesNodeNotReady' })], live, new Set()))
      .toEqual([]);
  });

  it('leaves a node that still holds a replica or an engine', () => {
    expect(planLonghornNodeReap([lhNode('w1', GONE)], live, new Set(['w1']))).toEqual([]);
  });

  it('plans nothing from an empty Kubernetes node list (an API anomaly, not every node leaving)', () => {
    expect(planLonghornNodeReap([lhNode('w1', GONE)], new Set(), new Set())).toEqual([]);
  });

  it('plans the disk-status alignment for a node removed before its disk status synced', () => {
    const stuck: LonghornNodeShape = { ...lhNode('w1', GONE), spec: { allowScheduling: true, disks: { d1: {} } } };
    expect(planLonghornNodeReap([stuck], live, new Set())).toEqual([
      { name: 'w1', allowScheduling: true, diskStatusFix: { d1: {} } },
    ]);
  });

  it('remembers that scheduling was already off', () => {
    expect(planLonghornNodeReap([lhNode('w1', GONE, false)], live, new Set()))
      .toEqual([{ name: 'w1', allowScheduling: false, diskStatusFix: null }]);
  });
});

function makeK8s(over: Partial<Record<'patch' | 'del' | 'list' | 'status' | 'readNode', ReturnType<typeof vi.fn>>> = {}) {
  const patch = over.patch ?? vi.fn().mockResolvedValue({});
  const status = over.status ?? vi.fn().mockResolvedValue({});
  // Default: the Kubernetes node is gone.
  const readNode = over.readNode ?? vi.fn().mockRejectedValue(httpError(404));
  const del = over.del ?? vi.fn().mockResolvedValue({});
  const list = over.list ?? vi.fn().mockResolvedValue({ items: [] });
  const k8s = {
    core: { readNode },
    custom: {
      patchNamespacedCustomObjectStatus: status,
      patchNamespacedCustomObject: patch,
      deleteNamespacedCustomObject: del,
      listNamespacedCustomObject: list,
    },
  } as unknown as K8sClients;
  return { k8s, patch, del, list, status };
}

const scheduling = (patch: ReturnType<typeof vi.fn>) =>
  patch.mock.calls.map((c) => (c[0] as { body: { spec: { allowScheduling: boolean } } }).body.spec.allowScheduling);

describe('diskStatusFixFor (the webhook refuses every update until disk spec and status match)', () => {
  it('is null when every spec disk has a status entry and no other does', () => {
    expect(diskStatusFixFor({ spec: { disks: { d1: {} } }, status: { diskStatus: { d1: { x: 1 } } } })).toBeNull();
  });

  it('adds an entry for a spec disk whose status never synced (status null — node removed right after joining)', () => {
    expect(diskStatusFixFor({ spec: { disks: { d1: {} } }, status: { diskStatus: null } })).toEqual({ d1: {} });
  });

  it('drops a status entry for a disk no longer in the spec', () => {
    expect(diskStatusFixFor({ spec: { disks: {} }, status: { diskStatus: { old: {} } } })).toEqual({ old: null });
  });
});

describe('reapLonghornNode', () => {
  it('aligns an unsynced disk status first, through the status subresource', async () => {
    const { k8s, patch, del, status } = makeK8s();
    await expect(reapLonghornNode(k8s, { name: 'w1', allowScheduling: true, diskStatusFix: { d1: {} } }))
      .resolves.toBe('deleted');
    expect(status).toHaveBeenCalledWith(
      expect.objectContaining({ plural: 'nodes', name: 'w1', body: { status: { diskStatus: { d1: {} } } } }),
      expect.anything(),
    );
    expect(status.mock.invocationCallOrder[0]).toBeLessThan(patch.mock.invocationCallOrder[0]);
    expect(patch.mock.invocationCallOrder[0]).toBeLessThan(del.mock.invocationCallOrder[0]);
  });

  it('leaves the status alone when it is in sync', async () => {
    const { k8s, status } = makeK8s();
    await reapLonghornNode(k8s, { name: 'w1', allowScheduling: true, diskStatusFix: null });
    expect(status).not.toHaveBeenCalled();
  });

  it('turns scheduling off, then deletes', async () => {
    const { k8s, patch, del } = makeK8s();
    await expect(reapLonghornNode(k8s, { name: 'w1', allowScheduling: true, diskStatusFix: null })).resolves.toBe('deleted');
    expect(scheduling(patch)).toEqual([false]);
    expect(del).toHaveBeenCalledWith(expect.objectContaining({ plural: 'nodes', name: 'w1', namespace: 'longhorn-system' }));
    expect(patch.mock.invocationCallOrder[0]).toBeLessThan(del.mock.invocationCallOrder[0]);
  });

  it('restores scheduling when Longhorn refuses the delete (422)', async () => {
    const { k8s, patch } = makeK8s({ del: vi.fn().mockRejectedValue(httpError(422)) });
    await expect(reapLonghornNode(k8s, { name: 'w1', allowScheduling: true, diskStatusFix: null })).resolves.toBe('refused');
    expect(scheduling(patch)).toEqual([false, true]);
  });

  it('does not touch scheduling that was already off — and does not turn it on after a refusal', async () => {
    const { k8s, patch } = makeK8s({ del: vi.fn().mockRejectedValue(httpError(422)) });
    await expect(reapLonghornNode(k8s, { name: 'w1', allowScheduling: false, diskStatusFix: null })).resolves.toBe('refused');
    expect(patch).not.toHaveBeenCalled();
  });

  it('treats a node that disappeared meanwhile as absent', async () => {
    const { k8s, del } = makeK8s({ patch: vi.fn().mockRejectedValue(httpError(404)) });
    await expect(reapLonghornNode(k8s, { name: 'w1', allowScheduling: true, diskStatusFix: null })).resolves.toBe('absent');
    expect(del).not.toHaveBeenCalled();
  });

  it('counts a node Longhorn deleted itself once scheduling was off (delete 404) as deleted', async () => {
    const { k8s, patch } = makeK8s({ del: vi.fn().mockRejectedValue(httpError(404)) });
    await expect(reapLonghornNode(k8s, { name: 'w1', allowScheduling: true, diskStatusFix: null })).resolves.toBe('deleted');
    expect(scheduling(patch)).toEqual([false]);
  });

  it('restores scheduling and rethrows any other delete failure', async () => {
    const { k8s, patch } = makeK8s({ del: vi.fn().mockRejectedValue(httpError(403)) });
    await expect(reapLonghornNode(k8s, { name: 'w1', allowScheduling: true, diskStatusFix: null })).rejects.toThrow('HTTP 403');
    expect(scheduling(patch)).toEqual([false, true]);
  });
});

describe('reapOrphanLonghornNodes', () => {
  function listing(items: Record<string, unknown[] | 'absent'>) {
    return vi.fn().mockImplementation(async (req: { plural: string }) => {
      const v = items[req.plural];
      if (v === 'absent') throw httpError(404);
      return { items: v ?? [] };
    });
  }

  it('removes the residue of a removed node and nothing else', async () => {
    const { k8s, del } = makeK8s({
      list: listing({ nodes: [lhNode('s1', UP), lhNode('w1', GONE)], replicas: [{ spec: { nodeID: 's1' } }], engines: [] }),
    });
    await expect(reapOrphanLonghornNodes(k8s, ['s1'])).resolves.toEqual(['w1']);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('does not reap a node that re-joined since the tick read the Node list', async () => {
    const { k8s, del, patch } = makeK8s({
      list: listing({ nodes: [lhNode('s1', UP), lhNode('w1', GONE)], replicas: [], engines: [] }),
      readNode: vi.fn().mockResolvedValue({ metadata: { name: 'w1' } }),
    });
    await expect(reapOrphanLonghornNodes(k8s, ['s1'])).resolves.toEqual([]);
    expect(patch).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('does not reap when the fresh node read fails for another reason', async () => {
    const { k8s, del } = makeK8s({
      list: listing({ nodes: [lhNode('s1', UP), lhNode('w1', GONE)], replicas: [], engines: [] }),
      readNode: vi.fn().mockRejectedValue(httpError(500)),
    });
    await expect(reapOrphanLonghornNodes(k8s, ['s1'])).resolves.toEqual([]);
    expect(del).not.toHaveBeenCalled();
  });

  it('keeps a gone node that still holds an engine', async () => {
    const { k8s, del } = makeK8s({
      list: listing({ nodes: [lhNode('s1', UP), lhNode('w1', GONE)], replicas: [], engines: [{ spec: { nodeID: 'w1' } }] }),
    });
    await expect(reapOrphanLonghornNodes(k8s, ['s1'])).resolves.toEqual([]);
    expect(del).not.toHaveBeenCalled();
  });

  it('lists nothing more in the steady state (every Longhorn node is live)', async () => {
    const list = listing({ nodes: [lhNode('s1', UP)] });
    const { k8s } = makeK8s({ list });
    await expect(reapOrphanLonghornNodes(k8s, ['s1'])).resolves.toEqual([]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('is a no-op without Longhorn', async () => {
    const { k8s, del } = makeK8s({ list: listing({ nodes: 'absent' }) });
    await expect(reapOrphanLonghornNodes(k8s, ['s1'])).resolves.toEqual([]);
    expect(del).not.toHaveBeenCalled();
  });

  it('never throws — a failed listing is logged and the tick goes on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { k8s } = makeK8s({ list: vi.fn().mockRejectedValue(httpError(500)) });
    await expect(reapOrphanLonghornNodes(k8s, ['s1'])).resolves.toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

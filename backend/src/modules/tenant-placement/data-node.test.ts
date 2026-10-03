import { describe, expect, it, vi } from 'vitest';
import {
  attachedNodeOf,
  chooseDataNode,
  resolveTenantDataNode,
  usableReplicaNodes,
} from './data-node.js';

describe('chooseDataNode', () => {
  it('follows the node the volume is attached to, whatever else is known', () => {
    expect(chooseDataNode({ attachedNode: 'node-b', mountedNode: 'node-c', replicaNodes: ['node-a'], pinNode: 'node-a' }))
      .toEqual({ node: 'node-b', source: 'attached' });
  });

  it('falls back to the node of a running pod that mounts the volume', () => {
    expect(chooseDataNode({ attachedNode: null, mountedNode: 'node-c', replicaNodes: ['node-a'], pinNode: 'node-a' }))
      .toEqual({ node: 'node-c', source: 'mounted' });
  });

  it('goes to the replica node when nothing has the volume attached', () => {
    // The production case: a stopped tenant pinned to node-a whose only replica is
    // on node-a — a backup pod scheduled to node-b copied the whole volume across.
    expect(chooseDataNode({ attachedNode: null, mountedNode: null, replicaNodes: ['node-a'], pinNode: 'node-a' }))
      .toEqual({ node: 'node-a', source: 'replica' });
  });

  it('follows the data, not the pin, when the data already lives elsewhere', () => {
    expect(chooseDataNode({ attachedNode: null, mountedNode: null, replicaNodes: ['node-b'], pinNode: 'node-a' }))
      .toEqual({ node: 'node-b', source: 'replica' });
  });

  it('prefers the pin among several replica nodes, else the first by name', () => {
    expect(chooseDataNode({ attachedNode: null, mountedNode: null, replicaNodes: ['node-c', 'node-b'], pinNode: 'node-c' }).node).toBe('node-c');
    expect(chooseDataNode({ attachedNode: null, mountedNode: null, replicaNodes: ['node-c', 'node-b'], pinNode: 'node-a' }).node).toBe('node-b');
  });

  it('falls back to the pin, then to nothing', () => {
    expect(chooseDataNode({ attachedNode: null, mountedNode: null, replicaNodes: [], pinNode: 'node-a' }))
      .toEqual({ node: 'node-a', source: 'pin' });
    expect(chooseDataNode({ attachedNode: null, mountedNode: null, replicaNodes: [], pinNode: null }))
      .toEqual({ node: null, source: null });
  });

  it('never returns a value that is not a node name', () => {
    expect(chooseDataNode({ attachedNode: 'a b', mountedNode: '-x', replicaNodes: ['$(x)'], pinNode: '' }))
      .toEqual({ node: null, source: null });
  });
});

describe('attachedNodeOf', () => {
  it('is the current node only while Longhorn reports the volume attached', () => {
    expect(attachedNodeOf({ status: { state: 'attached', currentNodeID: 'node-b' } })).toBe('node-b');
    // Detached volumes keep an EMPTY currentNodeID, and an attaching one has no
    // node that can mount it yet — neither is evidence of where the data is.
    expect(attachedNodeOf({ status: { state: 'detached', currentNodeID: '' } })).toBeNull();
    expect(attachedNodeOf({ status: { state: 'attaching', currentNodeID: 'node-b' } })).toBeNull();
    expect(attachedNodeOf({ status: { state: 'attached', currentNodeID: '' } })).toBeNull();
    expect(attachedNodeOf({})).toBeNull();
  });
});

describe('usableReplicaNodes', () => {
  it('skips failed and errored replicas', () => {
    expect(usableReplicaNodes([
      { spec: { nodeID: 'node-a', failedAt: '2026-10-02T05:09:25Z' }, status: { currentState: 'running' } },
      { spec: { nodeID: 'node-c', failedAt: '' }, status: { currentState: 'error' } },
      { spec: { nodeID: 'node-b', failedAt: '' }, status: { currentState: 'stopped' } },
    ])).toEqual(['node-b']);
  });
});

const PVC = 'tenant-a-storage';
const mounting = (phase: string, nodeName: string, extra: Record<string, unknown> = {}) => ({
  status: { phase },
  spec: { nodeName, volumes: [{ persistentVolumeClaim: { claimName: PVC } }] },
  ...extra,
});

function fakeK8s(opts: {
  pods?: unknown[];
  pvcVolume?: string | null;
  volume?: unknown;
  replicas?: unknown[];
  failPods?: boolean;
  failLonghorn?: boolean;
}) {
  return {
    core: {
      listNamespacedPod: vi.fn(async () => {
        if (opts.failPods) throw new Error('boom');
        return { items: opts.pods ?? [] };
      }),
      readNamespacedPersistentVolumeClaim: vi.fn(async () => ({ spec: { volumeName: opts.pvcVolume ?? undefined } })),
    },
    custom: {
      getNamespacedCustomObject: vi.fn(async (req: { plural: string; name: string }) => {
        if (opts.failLonghorn) throw new Error('longhorn down');
        expect(req).toMatchObject({ plural: 'volumes', name: opts.pvcVolume });
        return opts.volume ?? { status: { state: 'detached', currentNodeID: '' } };
      }),
      listNamespacedCustomObject: vi.fn(async (req: { labelSelector?: string }) => {
        if (opts.failLonghorn) throw new Error('longhorn down');
        expect(req.labelSelector).toBe(`longhornvolume=${opts.pvcVolume}`);
        return { items: opts.replicas ?? [] };
      }),
    },
  } as never;
}

describe('resolveTenantDataNode', () => {
  const base = { namespace: 'tenant-a', pvcName: PVC, pinNode: 'node-a' };

  it('follows Longhorn, not a Pending pod bound to a node the volume cannot attach to', async () => {
    // The production failure: the file manager was pinned to node-a and stuck
    // Pending (Multi-Attach) while the app pods held the RWO volume on node-b.
    // The pod listing returns it first, so a pod-based answer pinned the backup
    // Job to node-a, where it could never start.
    const k8s = fakeK8s({
      pvcVolume: 'pvc-1',
      volume: { status: { state: 'attached', currentNodeID: 'node-b' } },
      pods: [mounting('Pending', 'node-a'), mounting('Running', 'node-b')],
    });
    expect(await resolveTenantDataNode(k8s, base)).toEqual({ node: 'node-b', source: 'attached' });
    expect((k8s as any).core.listNamespacedPod).not.toHaveBeenCalled();
  });

  it('never treats a Pending pod as where the data is', async () => {
    const k8s = fakeK8s({
      pvcVolume: 'pvc-1',
      pods: [mounting('Pending', 'node-z')],
      replicas: [{ spec: { nodeID: 'node-b' }, status: { currentState: 'stopped' } }],
    });
    expect(await resolveTenantDataNode(k8s, base)).toEqual({ node: 'node-b', source: 'replica' });
  });

  it('uses a running, not-terminating pod when Longhorn cannot be read', async () => {
    const warn = vi.fn();
    const k8s = fakeK8s({
      pvcVolume: 'pvc-1',
      failLonghorn: true,
      pods: [
        mounting('Succeeded', 'node-z'),
        mounting('Pending', 'node-x'),
        mounting('Running', 'node-y', { metadata: { deletionTimestamp: 'x' } }),
        mounting('Running', 'node-b'),
      ],
    });
    expect(await resolveTenantDataNode(k8s, { ...base, logger: { warn } })).toEqual({ node: 'node-b', source: 'mounted' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reads the replica node of a detached volume', async () => {
    const k8s = fakeK8s({ pvcVolume: 'pvc-1', replicas: [{ spec: { nodeID: 'node-a' }, status: { currentState: 'stopped' } }] });
    expect(await resolveTenantDataNode(k8s, base)).toEqual({ node: 'node-a', source: 'replica' });
  });

  it('degrades to the pin when nothing can be read, and never throws', async () => {
    const warn = vi.fn();
    const k8s = fakeK8s({ failPods: true, pvcVolume: 'pvc-1', failLonghorn: true });
    expect(await resolveTenantDataNode(k8s, { ...base, logger: { warn } })).toEqual({ node: 'node-a', source: 'pin' });
    // Longhorn volume, pod listing, Longhorn replicas — each failure is reported.
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('with unambiguousOnly, refuses to choose between replica nodes the pin is not among', async () => {
    const k8s = fakeK8s({ pvcVolume: 'pvc-1', replicas: [{ spec: { nodeID: 'node-b' } }, { spec: { nodeID: 'node-c' } }] });
    expect(await resolveTenantDataNode(k8s, { ...base, unambiguousOnly: true })).toEqual({ node: null, source: null });
    expect(await resolveTenantDataNode(k8s, { ...base, pinNode: 'node-c', unambiguousOnly: true })).toEqual({ node: 'node-c', source: 'replica' });
  });

  it('with unambiguousOnly, still follows an attached HA volume', async () => {
    const k8s = fakeK8s({
      pvcVolume: 'pvc-1',
      volume: { status: { state: 'attached', currentNodeID: 'node-c' } },
      replicas: [{ spec: { nodeID: 'node-b' } }, { spec: { nodeID: 'node-c' } }],
    });
    expect(await resolveTenantDataNode(k8s, { ...base, unambiguousOnly: true })).toEqual({ node: 'node-c', source: 'attached' });
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  chooseDataNode,
  resolveTenantDataNode,
  usableReplicaNodes,
} from './data-node.js';

describe('chooseDataNode', () => {
  it('follows the pod that has the volume attached, whatever else is known', () => {
    expect(chooseDataNode({ attachedNode: 'node-b', replicaNodes: ['node-a'], pinNode: 'node-a' }))
      .toEqual({ node: 'node-b', source: 'attached' });
  });

  it('goes to the replica node when nothing has the volume attached', () => {
    // The production case: a stopped tenant pinned to node-a whose only replica is
    // on node-a — a backup pod scheduled to node-b copied the whole volume across.
    expect(chooseDataNode({ attachedNode: null, replicaNodes: ['node-a'], pinNode: 'node-a' }))
      .toEqual({ node: 'node-a', source: 'replica' });
  });

  it('follows the data, not the pin, when the data already lives elsewhere', () => {
    expect(chooseDataNode({ attachedNode: null, replicaNodes: ['node-b'], pinNode: 'node-a' }))
      .toEqual({ node: 'node-b', source: 'replica' });
  });

  it('prefers the pin among several replica nodes, else the first by name', () => {
    expect(chooseDataNode({ attachedNode: null, replicaNodes: ['node-c', 'node-b'], pinNode: 'node-c' }).node).toBe('node-c');
    expect(chooseDataNode({ attachedNode: null, replicaNodes: ['node-c', 'node-b'], pinNode: 'node-a' }).node).toBe('node-b');
  });

  it('falls back to the pin, then to nothing', () => {
    expect(chooseDataNode({ attachedNode: null, replicaNodes: [], pinNode: 'node-a' }))
      .toEqual({ node: 'node-a', source: 'pin' });
    expect(chooseDataNode({ attachedNode: null, replicaNodes: [], pinNode: null }))
      .toEqual({ node: null, source: null });
  });

  it('never returns a value that is not a node name', () => {
    expect(chooseDataNode({ attachedNode: 'a b', replicaNodes: ['$(x)'], pinNode: '' }))
      .toEqual({ node: null, source: null });
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

function fakeK8s(opts: {
  pods?: unknown[];
  pvcVolume?: string | null;
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
      listNamespacedCustomObject: vi.fn(async (req: { labelSelector?: string }) => {
        if (opts.failLonghorn) throw new Error('longhorn down');
        expect(req.labelSelector).toBe(`longhornvolume=${opts.pvcVolume}`);
        return { items: opts.replicas ?? [] };
      }),
    },
  } as never;
}

describe('resolveTenantDataNode', () => {
  const base = { namespace: 'tenant-a', pvcName: 'tenant-a-storage', pinNode: 'node-a' };

  it('uses the attached pod and skips Longhorn entirely', async () => {
    const k8s = fakeK8s({
      pods: [
        { status: { phase: 'Succeeded' }, spec: { nodeName: 'node-z', volumes: [{ persistentVolumeClaim: { claimName: 'tenant-a-storage' } }] } },
        { status: { phase: 'Running' }, metadata: { deletionTimestamp: 'x' }, spec: { nodeName: 'node-y', volumes: [{ persistentVolumeClaim: { claimName: 'tenant-a-storage' } }] } },
        { status: { phase: 'Running' }, spec: { nodeName: 'node-b', volumes: [{ persistentVolumeClaim: { claimName: 'tenant-a-storage' } }] } },
      ],
    });
    expect(await resolveTenantDataNode(k8s, base)).toEqual({ node: 'node-b', source: 'attached' });
    expect((k8s as any).custom.listNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('reads the replica node of a detached volume', async () => {
    const k8s = fakeK8s({ pvcVolume: 'pvc-1', replicas: [{ spec: { nodeID: 'node-a' }, status: { currentState: 'stopped' } }] });
    expect(await resolveTenantDataNode(k8s, base)).toEqual({ node: 'node-a', source: 'replica' });
  });

  it('degrades to the pin when Longhorn cannot be read, and never throws', async () => {
    const warn = vi.fn();
    const k8s = fakeK8s({ failPods: true, pvcVolume: 'pvc-1', failLonghorn: true });
    expect(await resolveTenantDataNode(k8s, { ...base, logger: { warn } })).toEqual({ node: 'node-a', source: 'pin' });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('with unambiguousOnly, refuses to choose between replica nodes the pin is not among', async () => {
    const k8s = fakeK8s({ pvcVolume: 'pvc-1', replicas: [{ spec: { nodeID: 'node-b' } }, { spec: { nodeID: 'node-c' } }] });
    expect(await resolveTenantDataNode(k8s, { ...base, unambiguousOnly: true })).toEqual({ node: null, source: null });
    expect(await resolveTenantDataNode(k8s, { ...base, pinNode: 'node-c', unambiguousOnly: true })).toEqual({ node: 'node-c', source: 'replica' });
  });
});

/**
 * Re-pinning a tenant off a dead node has to remove the pods stranded there,
 * and must NOT do that to a live one.
 *
 * The bug this guards (measured on staging, 2026-09-11): tenant workloads use
 * `strategy: Recreate` — correct, because their volume is RWO and two pods
 * cannot mount it at once. Recreate waits for every old pod to be FULLY GONE
 * before creating a new one, and a pod on a dead node never gets there: only
 * its kubelet can confirm the container stopped, so the pod object sits in
 * `Terminating` indefinitely and the Deployment waits behind it indefinitely.
 *
 * The re-pin itself succeeded in every visible way — Deployment patched,
 * Longhorn volume patched, platform DB updated — and the tenant stayed `0/1`
 * with no replacement ReplicaSet. Force-deleting the stranded pod produced one
 * within seconds.
 *
 * The Ready check is the safety boundary, not a nicety: force-delete drops the
 * pod object with no confirmation the container stopped, so on a LIVE node it
 * would risk two writers on one RWO volume.
 */
import { describe, it, expect, vi } from 'vitest';
import { strandedPodsOnDeadNode } from './service.js';

type K8s = Parameters<typeof strandedPodsOnDeadNode>[0];

const node = (readyStatus: string | undefined) => ({
  status: { conditions: readyStatus === undefined ? [] : [{ type: 'Ready', status: readyStatus }] },
});

const makeK8s = (readyStatus: string | undefined, podNames: string[]) => {
  const listNamespacedPod = vi.fn(async () => ({
    items: podNames.map((n) => ({ metadata: { name: n } })),
  }));
  return {
    k8s: {
      core: { readNode: vi.fn(async () => node(readyStatus)), listNamespacedPod },
    } as unknown as K8s,
    listNamespacedPod,
  };
};

describe('strandedPodsOnDeadNode', () => {
  it('returns the pods on a NotReady node', async () => {
    const { k8s } = makeK8s('Unknown', ['web-abc', 'file-manager-xyz']);
    expect(await strandedPodsOnDeadNode(k8s, 'tenant-acme', 'node-c'))
      .toEqual(['web-abc', 'file-manager-xyz']);
  });

  it('treats Ready=False as dead too', async () => {
    const { k8s } = makeK8s('False', ['web-abc']);
    expect(await strandedPodsOnDeadNode(k8s, 'tenant-acme', 'node-c')).toEqual(['web-abc']);
  });

  it('treats a MISSING Ready condition as dead — absence is not health', async () => {
    const { k8s } = makeK8s(undefined, ['web-abc']);
    expect(await strandedPodsOnDeadNode(k8s, 'tenant-acme', 'node-c')).toEqual(['web-abc']);
  });

  it('returns NOTHING for a Ready node, and does not even list its pods', async () => {
    // The safety boundary. On a live node the kubelet terminates pods properly;
    // force-deleting them would risk two writers on one RWO volume.
    const { k8s, listNamespacedPod } = makeK8s('True', ['web-abc']);
    expect(await strandedPodsOnDeadNode(k8s, 'tenant-acme', 'node-a')).toEqual([]);
    expect(listNamespacedPod).not.toHaveBeenCalled();
  });

  it('scopes the pod query to the tenant namespace and the released node', async () => {
    // A field selector that missed the node would return the whole namespace
    // and force-delete healthy pods elsewhere in the cluster.
    const { k8s, listNamespacedPod } = makeK8s('Unknown', ['web-abc']);
    await strandedPodsOnDeadNode(k8s, 'tenant-acme', 'node-c');
    const arg = listNamespacedPod.mock.calls[0][0] as unknown as {
      namespace: string; fieldSelector: string;
    };
    expect(arg.namespace).toBe('tenant-acme');
    expect(arg.fieldSelector).toBe('spec.nodeName=node-c');
  });

  it('returns an empty list when the dead node has no pods left', async () => {
    const { k8s } = makeK8s('Unknown', []);
    expect(await strandedPodsOnDeadNode(k8s, 'tenant-acme', 'node-c')).toEqual([]);
  });

  it('drops pods with no name rather than emitting an empty delete target', async () => {
    const k8s = {
      core: {
        readNode: vi.fn(async () => node('Unknown')),
        listNamespacedPod: vi.fn(async () => ({ items: [{ metadata: {} }, { metadata: { name: 'web-abc' } }] })),
      },
    } as unknown as K8s;
    expect(await strandedPodsOnDeadNode(k8s, 'tenant-acme', 'node-c')).toEqual(['web-abc']);
  });
});

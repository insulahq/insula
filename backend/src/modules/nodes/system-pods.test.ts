import { describe, it, expect, vi } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { assertTaintSafeForSystem, moveSystemPodsOff, podsToMoveOff, taintBlocksSystem, toleratesServerOnly } from './system-pods.js';

const ds = (name: string, tolerations?: unknown[]) => ({ metadata: { name }, spec: { template: { spec: { tolerations } } } });
const k8sWithDs = (items: unknown[] | Error) => ({
  apps: { listNamespacedDaemonSet: vi.fn(async () => { if (items instanceof Error) throw items; return { items }; }) },
}) as unknown as K8sClients;

describe('the tenant taint must not keep system components off a server', () => {
  it('a toleration for the key, or a blanket Exists, covers it; others do not', () => {
    expect(toleratesServerOnly([{ key: 'insula.host/server-only', operator: 'Equal', effect: 'NoSchedule' }])).toBe(true);
    expect(toleratesServerOnly([{ key: 'insula.host/server-only', operator: 'Exists' }])).toBe(true);
    expect(toleratesServerOnly([{ operator: 'Exists' }])).toBe(true);
    expect(toleratesServerOnly([{ key: 'node.kubernetes.io/unschedulable', operator: 'Exists' }])).toBe(false);
    expect(toleratesServerOnly(undefined)).toBe(false);
  });

  it('names the Longhorn DaemonSets that would not come back after a reboot (lab staging: CSI plugin, engine image)', async () => {
    const k8s = k8sWithDs([
      ds('longhorn-csi-plugin'),
      ds('engine-image-ei-0a1b2c3d', [{ key: 'node.kubernetes.io/unschedulable', operator: 'Exists' }]),
      ds('longhorn-manager', [{ key: 'insula.host/server-only', operator: 'Equal', effect: 'NoSchedule' }]),
    ]);
    expect(await taintBlocksSystem(k8s)).toEqual(['longhorn-system/longhorn-csi-plugin', 'longhorn-system/engine-image-ei-0a1b2c3d']);
    await expect(assertTaintSafeForSystem(k8s, 's2')).rejects.toMatchObject({
      code: 'NODE_TENANT_TAINT_UNSAFE', status: 409,
      details: { daemonsets: ['longhorn-system/longhorn-csi-plugin', 'longhorn-system/engine-image-ei-0a1b2c3d'] },
    });
  });

  it('no Longhorn, or all tolerating: the taint may go on', async () => {
    await expect(assertTaintSafeForSystem(k8sWithDs(Object.assign(new Error('nf'), { code: 404 })), 's2')).resolves.toBeUndefined();
    await expect(assertTaintSafeForSystem(k8sWithDs([ds('longhorn-csi-plugin', [{ operator: 'Exists' }])]), 's2')).resolves.toBeUndefined();
  });

  it('cannot read the DaemonSets: refuse (fail closed) rather than risk a server\'s storage', async () => {
    await expect(assertTaintSafeForSystem(k8sWithDs(Object.assign(new Error('timeout'), { code: 500 })), 's2')).rejects.toThrow('timeout');
  });
});

describe('Delete Node moves the system pods off — cordon, evict, wait', () => {
  const pod = (namespace: string, name: string, o: { owner?: string; phase?: string; mirror?: boolean } = {}) => ({
    metadata: {
      namespace, name,
      ownerReferences: o.owner ? [{ kind: o.owner }] : [],
      annotations: o.mirror ? { 'kubernetes.io/config.mirror': 'x' } : {},
    },
    status: { phase: o.phase ?? 'Running' },
  });

  it('leaves DaemonSet, static and finished pods; moves the rest', () => {
    expect(podsToMoveOff([
      pod('cert-manager', 'cert-manager-x', { owner: 'ReplicaSet' }),
      pod('longhorn-system', 'longhorn-csi-plugin-x', { owner: 'DaemonSet' }),
      pod('kube-system', 'kube-proxy-x', { mirror: true }),
      pod('traefik', 'job-x', { owner: 'Job', phase: 'Succeeded' }),
      pod('platform', 'system-db-2', { owner: 'Cluster' }),
    ])).toEqual([{ namespace: 'cert-manager', name: 'cert-manager-x' }, { namespace: 'platform', name: 'system-db-2' }]);
  });

  function k8sFor(listings: unknown[][], evictImpl: (req: { name: string }) => Promise<unknown> = async () => ({})) {
    let call = 0;
    const patchNode = vi.fn(async () => ({}));
    const evict = vi.fn(evictImpl);
    const k8s = {
      core: {
        patchNode,
        listPodForAllNamespaces: vi.fn(async () => ({ items: listings[Math.min(call++, listings.length - 1)] })),
        createNamespacedPodEviction: evict,
      },
    } as unknown as K8sClients;
    return { k8s, patchNode, evict };
  }

  it('cordons first, evicts each pod, waits until they are gone', async () => {
    const pods = [pod('cert-manager', 'cm-1', { owner: 'ReplicaSet' }), pod('platform', 'system-db-2', { owner: 'Cluster' })];
    const { k8s, patchNode, evict } = k8sFor([pods, pods, []]);
    const sleep = vi.fn(async () => {});
    expect(await moveSystemPodsOff(k8s, 's2', 60_000, sleep)).toBe(2);
    expect(patchNode.mock.calls[0][0]).toMatchObject({ name: 's2', body: { spec: { unschedulable: true } } });
    expect(evict).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('an eviction a disruption budget refuses stops the delete — named, node left cordoned', async () => {
    const pods = [pod('platform', 'system-db-1', { owner: 'Cluster' })];
    const { k8s, patchNode } = k8sFor([pods], async () => { throw Object.assign(new Error('Cannot evict'), { code: 429 }); });
    await expect(moveSystemPodsOff(k8s, 's2', 60_000, async () => {})).rejects.toMatchObject({
      code: 'NODE_DELETE_EVICTION_BLOCKED', status: 409,
      details: { pods: ['platform/system-db-1 (its disruption budget allows no eviction now)'] },
    });
    expect(patchNode).toHaveBeenCalledTimes(1);
  });
});

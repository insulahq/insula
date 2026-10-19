import { describe, it, expect, vi } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  assertTaintSafeForSystem, longhornSettingToleratesServerOnly, moveSystemPodsOff, podsToMoveOff, taintBlocksSystem,
  toleratesServerOnly,
} from './system-pods.js';

const ds = (name: string, tolerations?: unknown[]) => ({ metadata: { name }, spec: { template: { spec: { tolerations } } } });
const TOLERATING_SETTING = 'insula.host/server-only=true:NoSchedule';
const k8sWithDs = (items: unknown[] | Error, setting: string | Error = TOLERATING_SETTING) => ({
  apps: { listNamespacedDaemonSet: vi.fn(async () => { if (items instanceof Error) throw items; return { items }; }) },
  custom: { getNamespacedCustomObject: vi.fn(async () => { if (setting instanceof Error) throw setting; return { value: setting }; }) },
}) as unknown as K8sClients;

describe('the tenant taint must not keep system components off a server', () => {
  it('a toleration for the key, or a blanket Exists, covers it; others do not', () => {
    expect(toleratesServerOnly([{ key: 'insula.host/server-only', operator: 'Equal', value: 'true', effect: 'NoSchedule' }])).toBe(true);
    expect(toleratesServerOnly([{ key: 'insula.host/server-only', value: 'true' }])).toBe(true); // Equal is the default
    expect(toleratesServerOnly([{ key: 'insula.host/server-only', operator: 'Equal', value: 'false', effect: 'NoSchedule' }])).toBe(false);
    expect(toleratesServerOnly([{ key: 'insula.host/server-only', operator: 'Exists', effect: 'NoExecute' }])).toBe(false);
    expect(toleratesServerOnly([{ key: 'insula.host/server-only', operator: 'Exists' }])).toBe(true);
    expect(toleratesServerOnly([{ operator: 'Exists' }])).toBe(true);
    expect(toleratesServerOnly([{ key: 'node.kubernetes.io/unschedulable', operator: 'Exists' }])).toBe(false);
    expect(toleratesServerOnly(undefined)).toBe(false);
  });

  it('names the Longhorn DaemonSets that would not come back after a reboot (lab staging: CSI plugin, engine image)', async () => {
    const k8s = k8sWithDs([
      ds('longhorn-csi-plugin'),
      ds('engine-image-ei-0a1b2c3d', [{ key: 'node.kubernetes.io/unschedulable', operator: 'Exists' }]),
      ds('longhorn-manager', [{ key: 'insula.host/server-only', operator: 'Equal', value: 'true', effect: 'NoSchedule' }]),
    ]);
    expect(await taintBlocksSystem(k8s)).toEqual(['longhorn-system/longhorn-csi-plugin', 'longhorn-system/engine-image-ei-0a1b2c3d']);
    await expect(assertTaintSafeForSystem(k8s, 's2')).rejects.toMatchObject({
      code: 'NODE_TENANT_TAINT_UNSAFE', status: 409,
      details: { components: ['longhorn-system/longhorn-csi-plugin', 'longhorn-system/engine-image-ei-0a1b2c3d'] },
    });
  });

  it('Longhorn\'s setting must tolerate it too — its instance managers (engines, replicas) are no DaemonSet', async () => {
    const tolerating = [ds('longhorn-csi-plugin', [{ operator: 'Exists' }])];
    expect(await taintBlocksSystem(k8sWithDs(tolerating, ''))).toEqual(['longhorn-system/setting taint-toleration']);
    expect(await taintBlocksSystem(k8sWithDs(tolerating, 'nvidia.com/gpu=true:NoSchedule'))).toEqual(['longhorn-system/setting taint-toleration']);
    expect(await taintBlocksSystem(k8sWithDs(tolerating, Object.assign(new Error('nf'), { code: 404 })))).toEqual(['longhorn-system/setting taint-toleration']);
    expect(await taintBlocksSystem(k8sWithDs(tolerating, `nvidia.com/gpu=true:NoSchedule;${TOLERATING_SETTING}`))).toEqual([]);
    await expect(taintBlocksSystem(k8sWithDs(tolerating, Object.assign(new Error('timeout'), { code: 500 })))).rejects.toThrow('timeout');
  });

  it('reads the setting the way Longhorn writes it', () => {
    expect(longhornSettingToleratesServerOnly(TOLERATING_SETTING)).toBe(true);
    expect(longhornSettingToleratesServerOnly('insula.host/server-only:NoSchedule')).toBe(true); // Exists
    expect(longhornSettingToleratesServerOnly(':')).toBe(true); // everything
    expect(longhornSettingToleratesServerOnly('insula.host/server-only=false:NoSchedule')).toBe(false);
    expect(longhornSettingToleratesServerOnly('insula.host/server-only=true:NoExecute')).toBe(false);
    expect(longhornSettingToleratesServerOnly('')).toBe(false);
    expect(longhornSettingToleratesServerOnly(';')).toBe(false);
    expect(longhornSettingToleratesServerOnly(undefined)).toBe(false);
  });

  it('no Longhorn, or all tolerating: the taint may go on', async () => {
    await expect(assertTaintSafeForSystem(k8sWithDs(Object.assign(new Error('nf'), { code: 404 })), 's2')).resolves.toBeUndefined();
    await expect(assertTaintSafeForSystem(k8sWithDs([ds('longhorn-csi-plugin', [{ operator: 'Exists' }])]), 's2')).resolves.toBeUndefined();
  });

  it('cannot read the DaemonSets or the setting: refuse (fail closed), named, rather than risk a server\'s storage', async () => {
    await expect(assertTaintSafeForSystem(k8sWithDs(Object.assign(new Error('timeout'), { code: 500 })), 's2'))
      .rejects.toMatchObject({ code: 'NODE_TAINT_PRECHECK_FAILED', status: 503, message: expect.stringContaining('timeout') });
    // Lab staging: the API's RBAC did not cover the setting — a 403 must not read as "tolerated" nor as a bare 500.
    const forbidden = Object.assign(new Error('HTTP-Code: 403\nMessage: forbidden'), { code: 403 });
    await expect(assertTaintSafeForSystem(k8sWithDs([ds('longhorn-csi-plugin', [{ operator: 'Exists' }])], forbidden), 's2'))
      .rejects.toMatchObject({ code: 'NODE_TAINT_PRECHECK_FAILED', status: 503, message: expect.stringContaining('HTTP-Code: 403)') });
  });
});

describe('Delete Node moves the system pods off — cordon, evict, wait', () => {
  const pod = (namespace: string, name: string, o: { owner?: string; ownerApi?: string; phase?: string; mirror?: boolean } = {}) => ({
    metadata: {
      namespace, name,
      ownerReferences: o.owner ? [{ kind: o.owner, apiVersion: o.ownerApi ?? 'apps/v1' }] : [],
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

  // Lab staging, Delete of a server after its database instance moved: the
  // instance manager's disruption budget refused the eviction (Longhorn keeps
  // it while the node holds a volume's last copy) and the delete stopped.
  it('leaves Longhorn\'s instance manager — it belongs to its node; another CRD kind of the same name is no exception', () => {
    expect(podsToMoveOff([
      pod('longhorn-system', 'instance-manager-74ad', { owner: 'InstanceManager', ownerApi: 'longhorn.io/v1beta2' }),
      pod('other', 'im-x', { owner: 'InstanceManager', ownerApi: 'example.test/v1' }),
    ])).toEqual([{ namespace: 'other', name: 'im-x' }]);
  });

  function k8sFor(
    listings: unknown[][],
    evictImpl: (req: { name: string }) => Promise<unknown> = async () => ({}),
    attached: Array<Array<{ name: string; node: string }>> | 'fail' = [[]],
  ) {
    let call = 0;
    let vcall = 0;
    const patchNode = vi.fn(async () => ({}));
    const evict = vi.fn(evictImpl);
    const k8s = {
      core: {
        patchNode,
        listPodForAllNamespaces: vi.fn(async () => ({ items: listings[Math.min(call++, listings.length - 1)] })),
        createNamespacedPodEviction: evict,
      },
      custom: {
        listNamespacedCustomObject: vi.fn(async () => {
          if (attached === 'fail') throw new Error('etcdserver: request timed out');
          return {
            items: attached[Math.min(vcall++, attached.length - 1)]!.map((v) => ({
              metadata: { name: v.name },
              status: { currentNodeID: v.node, kubernetesStatus: { namespace: 'monitoring', pvcName: v.name } },
            })),
          };
        }),
      },
    } as unknown as K8sClients;
    return { k8s, patchNode, evict };
  }

  it('waits until no Longhorn volume is attached to the node any more', async () => {
    const { k8s } = k8sFor([[]], undefined, [[{ name: 'vmsingle-storage', node: 's2' }, { name: 'other', node: 's1' }], []]);
    const sleep = vi.fn(async () => {});
    expect(await moveSystemPodsOff(k8s, 's2', 60_000, null, sleep)).toBe(0);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('a volume still attached when the wait runs out stops the delete, named; unreadable volumes too', async () => {
    const { k8s } = k8sFor([[]], undefined, [[{ name: 'vmsingle-storage', node: 's2' }]]);
    await expect(moveSystemPodsOff(k8s, 's2', 0, null, async () => {})).rejects.toMatchObject({
      code: 'NODE_DELETE_EVICTION_BLOCKED', details: { pods: ['volume monitoring/vmsingle-storage (still attached)'] },
    });
    const unreadable = k8sFor([[]], undefined, 'fail');
    await expect(moveSystemPodsOff(unreadable.k8s, 's2', 0, null, async () => {})).rejects.toMatchObject({
      details: { pods: ['Longhorn volumes (could not be read)'] },
    });
  });

  it('cordons first, evicts each pod, waits until they are gone', async () => {
    const pods = [pod('cert-manager', 'cm-1', { owner: 'ReplicaSet' }), pod('platform', 'system-db-2', { owner: 'Cluster' })];
    const { k8s, patchNode, evict } = k8sFor([pods, pods, []]);
    const sleep = vi.fn(async () => {});
    expect(await moveSystemPodsOff(k8s, 's2', 60_000, null, sleep)).toBe(2);
    expect(patchNode.mock.calls[0][0]).toMatchObject({ name: 's2', body: { spec: { unschedulable: true } } });
    expect(evict).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('an eviction a disruption budget refuses stops the delete — named, node left cordoned', async () => {
    const pods = [pod('platform', 'system-db-1', { owner: 'Cluster' })];
    const { k8s, patchNode } = k8sFor([pods], async () => { throw Object.assign(new Error('Cannot evict'), { code: 429 }); });
    await expect(moveSystemPodsOff(k8s, 's2', 60_000, null, async () => {})).rejects.toMatchObject({
      code: 'NODE_DELETE_EVICTION_BLOCKED', status: 409,
      details: { pods: ['platform/system-db-1 (its disruption budget allows no eviction now)'] },
    });
    expect(patchNode).toHaveBeenCalledTimes(1);
  });

  it('a pod still there when the wait runs out stops the delete — never deleted around it', async () => {
    const pods = [pod('platform', 'system-db-2', { owner: 'Cluster' })];
    const { k8s } = k8sFor([pods]);
    await expect(moveSystemPodsOff(k8s, 's2', 0, null, async () => {})).rejects.toMatchObject({
      code: 'NODE_DELETE_EVICTION_BLOCKED', status: 409, details: { pods: ['platform/system-db-2'] },
    });
  });

  it('never evicts the API pod serving the request — it goes with the node', async () => {
    const pods = [pod('platform', 'platform-api-abc', { owner: 'ReplicaSet' }), pod('cert-manager', 'cm-1', { owner: 'ReplicaSet' })];
    const { k8s, evict } = k8sFor([pods, [pods[0]]]);
    expect(await moveSystemPodsOff(k8s, 's2', 60_000, { namespace: 'platform', name: 'platform-api-abc' }, async () => {})).toBe(1);
    expect(evict.mock.calls.map((c) => (c[0] as { name: string }).name)).toEqual(['cm-1']);
  });
});

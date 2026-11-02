import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const { order } = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock('../../shared/scale-deployment.js', () => ({
  STORAGE_QUIESCED_ANNOTATION: 'insula.host/storage-quiesced',
  STORAGE_PREQUIESCE_REPLICAS_ANNOTATION: 'insula.host/pre-quiesce-replicas',
  scaleDeploymentReplicas: vi.fn(async (_ns: string, name: string, replicas: number) => {
    order.push(`scale ${name}->${replicas}`);
  }),
}));

import {
  colocateBeforeRestore, deploymentsToStart, nodeTakesPods, planRestoreColocation, type RestoreWorkload,
} from './restore-colocation.js';
import { unquiesce } from './quiesce.js';

const NS = 'tenant-acme';
const w = (name: string, o: Partial<RestoreWorkload> = {}): RestoreWorkload =>
  ({ name, pin: null, mountsData: true, running: false, ...o });

describe('planRestoreColocation', () => {
  it('puts unpinned workloads on the node the others are pinned to', () => {
    expect(planRestoreColocation([w('web', { pin: 'sv3' }), w('db')], null)).toEqual({ node: 'sv3', patch: ['db'] });
  });

  it('with nothing pinned, puts them on the data node', () => {
    expect(planRestoreColocation([w('web'), w('db'), w('crm')], 'sv3')).toEqual({ node: 'sv3', patch: ['web', 'db', 'crm'] });
  });

  it('never moves a pinned workload, never restarts a running one, and ignores one not sharing the volume', () => {
    expect(planRestoreColocation([
      w('web', { pin: 'sv3' }), w('crm', { running: true }), w('proxy', { mountsData: false }), w('db'),
    ], 'sv1')).toEqual({ node: 'sv3', patch: ['db'] });
  });

  it('leaves everything when the pins disagree or no node is known', () => {
    expect(planRestoreColocation([w('web', { pin: 'sv3' }), w('db', { pin: 'sv1' }), w('crm')], 'sv3')).toEqual({ node: null, patch: [] });
    expect(planRestoreColocation([w('web'), w('db')], null)).toEqual({ node: null, patch: [] });
  });
});

/**
 * The production tenant: three Deployments sharing one single-copy volume,
 * none pinned (a drain had cleared the selector), the copy on sv3.
 */
function cluster(o: {
  pins?: Record<string, string>;
  replicas?: number;
  attachedOn?: string;
  desired?: Record<string, number>;
  available?: Record<string, number>;
  failList?: boolean;
  /** The data node's state; default Ready and schedulable. */
  dataNode?: { unschedulable?: boolean; taint?: string; ready?: boolean };
} = {}) {
  const patched: Array<{ name: string; node: string }> = [];
  const desired = new Map<string, number>(
    ['website', 'perfex', 'my-mariadb'].map((n) => [n, o.desired?.[n] ?? 0]),
  );
  const deployment = (name: string) => ({
    metadata: { name },
    spec: {
      replicas: desired.get(name),
      template: { spec: {
        ...(o.pins?.[name] ? { nodeSelector: { 'kubernetes.io/hostname': o.pins[name] } } : {}),
        volumes: [{ persistentVolumeClaim: { claimName: `${NS}-storage` } }],
      } },
    },
    status: { availableReplicas: o.available?.[name] ?? 0 },
  });
  const k8s = {
    core: {
      readNamespacedPersistentVolumeClaim: async () => ({ spec: { volumeName: 'pvc-1' } }),
      listNamespacedPod: async () => ({ items: [] }),
      readNode: async () => ({
        spec: {
          unschedulable: o.dataNode?.unschedulable ?? false,
          taints: o.dataNode?.taint ? [{ key: o.dataNode.taint, effect: 'NoSchedule' }] : [],
        },
        status: { conditions: [{ type: 'Ready', status: o.dataNode?.ready === false ? 'Unknown' : 'True' }] },
      }),
    },
    apps: {
      listNamespacedDeployment: async () => {
        if (o.failList) throw new Error('API down');
        return { items: [...desired.keys()].map(deployment) };
      },
      patchNamespacedDeployment: async ({ name, body }: { name: string; body: Record<string, unknown> }) => {
        const node = (body as { spec?: { template?: { spec?: { nodeSelector?: Record<string, string> } } } })
          .spec?.template?.spec?.nodeSelector?.['kubernetes.io/hostname'];
        if (node) { patched.push({ name, node }); order.push(`pin ${name}->${node}`); }
        return {};
      },
      // unquiesce's "is it back?" read: every scaled workload comes up.
      readNamespacedDeployment: async () => ({
        metadata: { annotations: {} }, spec: { replicas: 1 }, status: { availableReplicas: 1 },
      }),
    },
    custom: {
      getNamespacedCustomObject: async () => ({
        spec: { numberOfReplicas: o.replicas ?? 1 },
        status: o.attachedOn ? { state: 'attached', currentNodeID: o.attachedOn } : { state: 'detached' },
      }),
      listNamespacedCustomObject: async () => ({ items: [{ spec: { nodeID: 'sv3' }, status: { currentState: 'stopped' } }] }),
    },
    batch: {},
  } as unknown as K8sClients;
  return { k8s, patched };
}

const ALL = [{ name: 'website', replicas: 1 }, { name: 'perfex', replicas: 1 }, { name: 'my-mariadb', replicas: 1 }];

beforeEach(() => { order.length = 0; });

describe('deploymentsToStart', () => {
  it('takes a snapshot count above 0, and a 0 still held with a recorded count', () => {
    const held = { metadata: { name: 'db', annotations: { 'insula.host/storage-quiesced': 'true', 'insula.host/pre-quiesce-replicas': '1' } } };
    expect([...deploymentsToStart(
      [{ name: 'web', replicas: 1 }, { name: 'db', replicas: 0 }, { name: 'file-manager', replicas: 0 }],
      [{ metadata: { name: 'web' } }, held, { metadata: { name: 'file-manager' } }],
    )].sort()).toEqual(['db', 'web']);
  });
});

describe('nodeTakesPods', () => {
  it('is false for a cordoned, NoSchedule-tainted or NotReady node', () => {
    const ok = { status: { conditions: [{ type: 'Ready', status: 'True' }] } };
    expect(nodeTakesPods(ok)).toBe(true);
    expect(nodeTakesPods({ ...ok, spec: { unschedulable: true } })).toBe(false);
    expect(nodeTakesPods({ ...ok, spec: { taints: [{ effect: 'NoSchedule' }] } })).toBe(false);
    expect(nodeTakesPods({ ...ok, spec: { taints: [{ effect: 'PreferNoSchedule' }] } })).toBe(true);
    expect(nodeTakesPods({ status: { conditions: [{ type: 'Ready', status: 'Unknown' }] } })).toBe(false);
  });
});

describe('colocateBeforeRestore', () => {
  it('pins every unpinned workload to the node holding the one copy', async () => {
    const c = cluster();
    const plan = await colocateBeforeRestore(c.k8s, NS, ALL);
    expect(plan.node).toBe('sv3');
    expect(c.patched).toEqual([
      { name: 'website', node: 'sv3' }, { name: 'perfex', node: 'sv3' }, { name: 'my-mariadb', node: 'sv3' },
    ]);
  });

  it('follows the volume where something already runs with it, and leaves the running ones alone', async () => {
    // The production state after the failed heal: web pods running on sv3, the database stuck elsewhere.
    const c = cluster({
      attachedOn: 'sv3',
      desired: { website: 1, perfex: 1, 'my-mariadb': 1 },
      available: { website: 1, perfex: 1 },
    });
    await colocateBeforeRestore(c.k8s, NS, ALL);
    expect(c.patched).toEqual([{ name: 'my-mariadb', node: 'sv3' }]);
  });

  it('leaves the workloads to the scheduler when the data node takes no new pods', async () => {
    for (const dataNode of [{ unschedulable: true }, { taint: 'insula.host/server-only' }, { ready: false }]) {
      const c = cluster({ dataNode });
      expect((await colocateBeforeRestore(c.k8s, NS, ALL)).node).toBeNull();
      expect(c.patched).toEqual([]);
    }
  });

  it('does not touch a Deployment the restore leaves stopped', async () => {
    const c = cluster();
    await colocateBeforeRestore(c.k8s, NS, [{ name: 'website', replicas: 1 }, { name: 'perfex', replicas: 0 }]);
    expect(c.patched).toEqual([{ name: 'website', node: 'sv3' }]);
  });

  it('holds an HA volume to no node, and never throws', async () => {
    const ha = cluster({ replicas: 2 });
    expect((await colocateBeforeRestore(ha.k8s, NS, ALL)).node).toBeNull();
    expect(ha.patched).toEqual([]);

    const down = cluster({ failList: true });
    await expect(colocateBeforeRestore(down.k8s, NS, ALL)).resolves.toEqual({ node: null, patch: [] });
  });

  it('runs before unquiesce scales anything up', async () => {
    const c = cluster();
    await unquiesce(c.k8s, NS, {
      deployments: [{ name: 'website', replicas: 1 }, { name: 'my-mariadb', replicas: 1 }],
      cronJobs: [],
    }, { availableTimeoutMs: 1_000 });
    expect(order.slice(0, 4)).toEqual([
      'pin website->sv3', 'pin my-mariadb->sv3', 'scale website->1', 'scale my-mariadb->1',
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { haPinSchedulingPatch, pinHaTenantSoftly } from './ha-pin.js';
import { HA_SHARED_VOLUME_AFFINITY } from './pod-placement.js';
import { repinTenantPlacement } from '../nodes/service.js';
import { repinDeployments } from '../tenant-migration/repin.js';

/**
 * A move of an HA tenant to a named node wrote the hostname pin on every
 * workload. Production: an HA tenant moved before this kept three apps
 * hard-pinned to the node it was moved to, so a restart of that node left them
 * waiting for auto-repin while the soft-pinned apps had already gone.
 */
const HOST = 'kubernetes.io/hostname';
const prefer = (node: string) => ({ weight: 100, preference: { matchExpressions: [{ key: HOST, operator: 'In', values: [node] }] } });
const notIn = (node: string) => ({ key: HOST, operator: 'NotIn', values: [node] });
const MANAGED = { 'platform.io/managed': 'true' };

/** RFC 7396, as the API server applies a merge patch. */
function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> = typeof target === 'object' && target !== null && !Array.isArray(target)
    ? { ...(target as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) delete out[k];
    else out[k] = applyMergePatch(out[k], v);
  }
  return out;
}

const applied = (spec: Record<string, unknown>, opts: Parameters<typeof haPinSchedulingPatch>[1]) =>
  applyMergePatch(spec, haPinSchedulingPatch(spec, opts));

describe('haPinSchedulingPatch', () => {
  it('turns a hard pin into what a deploy on the target renders', () => {
    const spec = { nodeSelector: { [HOST]: 'node-d' }, affinity: { nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [prefer('node-d')] } } };
    expect(applied(spec, { target: 'node-a', keepOff: null, tenantWorkload: true })).toEqual({
      affinity: {
        nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [prefer('node-a')] },
        podAffinity: HA_SHARED_VOLUME_AFFINITY,
      },
    });
  });

  it('keeps the pods off a node it leaves while that node is up', () => {
    expect(applied({ nodeSelector: { [HOST]: 'node-d' } }, { target: 'node-a', keepOff: 'node-d', tenantWorkload: true })).toEqual({
      affinity: {
        nodeAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [notIn('node-d')] }] },
          preferredDuringSchedulingIgnoredDuringExecution: [prefer('node-a')],
        },
        podAffinity: HA_SHARED_VOLUME_AFFINITY,
      },
    });
  });

  it('removes a required hostname pin and puts the exclusion into every other term', () => {
    const disk = { key: 'disk', operator: 'In', values: ['ssd'] };
    const zone = { key: 'zone', operator: 'In', values: ['a'] };
    const spec = { affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [
      { matchExpressions: [disk, { key: HOST, operator: 'In', values: ['node-d'] }] },
      { matchExpressions: [zone] },
    ] } } } };
    const out = applied(spec, { target: 'node-a', keepOff: 'node-d', tenantWorkload: true }) as {
      affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: unknown } };
    };
    expect(out.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution).toEqual({ nodeSelectorTerms: [
      { matchExpressions: [disk, notIn('node-d')] },
      { matchExpressions: [zone, notIn('node-d')] },
    ] });
  });

  it('drops an earlier move\'s exclusion and keeps every rule that is not about the hostname', () => {
    const anti = { preferredDuringSchedulingIgnoredDuringExecution: [{ weight: 1, podAffinityTerm: { labelSelector: { matchLabels: { x: 'y' } }, topologyKey: 'zone' } }] };
    const other = { weight: 10, preference: { matchExpressions: [{ key: 'zone', operator: 'In', values: ['a'] }] } };
    const spec = {
      nodeSelector: { 'kubernetes.io/os': 'linux' },
      affinity: {
        podAntiAffinity: anti,
        nodeAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [notIn('node-b')] }] },
          preferredDuringSchedulingIgnoredDuringExecution: [other, prefer('node-d')],
        },
      },
    };
    expect(applied(spec, { target: 'node-b', keepOff: null, tenantWorkload: true })).toEqual({
      nodeSelector: { 'kubernetes.io/os': 'linux' },
      affinity: {
        podAntiAffinity: anti,
        nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [other, prefer('node-b')] },
        podAffinity: HA_SHARED_VOLUME_AFFINITY,
      },
    });
  });

  it('gives a platform pod the node preference only, as platformPodPlacement renders', () => {
    expect(applied({ nodeSelector: { [HOST]: 'node-d' } }, { target: 'node-a', keepOff: null, tenantWorkload: false })).toEqual({
      affinity: { nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [prefer('node-a')] } },
    });
  });

  it('changes nothing on a workload already rendered for the target, read back with undefined fields', () => {
    const spec = {
      nodeSelector: undefined,
      affinity: {
        nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: undefined, preferredDuringSchedulingIgnoredDuringExecution: [prefer('node-a')] },
        podAffinity: HA_SHARED_VOLUME_AFFINITY,
        podAntiAffinity: undefined,
      },
    };
    expect(haPinSchedulingPatch(spec, { target: 'node-a', keepOff: null, tenantWorkload: true })).toBeNull();
  });
});

const podOf = (deploy: string, hash = 'abc12') => ({
  metadata: { name: `${deploy}-${hash}-xyz`, labels: { 'pod-template-hash': hash }, ownerReferences: [{ kind: 'ReplicaSet', name: `${deploy}-${hash}` }] },
});

const workload = (name: string, labels: Record<string, string>, spec: Record<string, unknown> = {}, replicas = 1) => ({
  metadata: { name },
  spec: { replicas, template: { metadata: { labels }, spec } },
});

function cluster(
  deployments: unknown[],
  opts: { nodeReady?: boolean; podsOnNode?: unknown[]; statefulSets?: unknown[]; failPatch?: string } = {},
) {
  const calls: Array<{ op: string; name: string; body?: unknown }> = [];
  const patch = (op: string) => async ({ name, body }: { name: string; body: unknown }) => {
    if (name === opts.failPatch) throw new Error('admission webhook denied');
    calls.push({ op, name, body });
    return {};
  };
  const k8s = {
    core: {
      readNode: async () => ({ status: { conditions: [{ type: 'Ready', status: opts.nodeReady === false ? 'Unknown' : 'True' }] } }),
      listNamespacedPod: async () => ({ items: opts.podsOnNode ?? [] }),
      deleteNamespacedPod: async ({ name }: { name: string }) => { calls.push({ op: 'delete-pod', name }); return {}; },
    },
    apps: {
      listNamespacedDeployment: async () => ({ items: deployments }),
      listNamespacedStatefulSet: async () => ({ items: opts.statefulSets ?? [] }),
      patchNamespacedDeployment: patch('patch'),
      patchNamespacedStatefulSet: patch('patch-sts'),
    },
    custom: {
      patchNamespacedCustomObject: async ({ plural, name, body }: { plural: string; name: string; body: unknown }) => {
        calls.push({ op: `patch-${plural}`, name, body });
        return {};
      },
      listNamespacedCustomObject: async () => ({ items: [] }),
    },
  } as unknown as K8sClients;
  const db = { update: () => ({ set: () => ({ where: async () => undefined }) }) } as unknown as Database;
  return { k8s, db, calls };
}

/** The production shape: catalog apps hard-pinned by an old move, custom apps soft, the platform proxy, the file manager. */
const movedTenantShape = () => [
  workload('my-mariadb', MANAGED, { nodeSelector: { [HOST]: 'node-d' }, affinity: { nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [prefer('node-d')] } } }),
  workload('artcraft', MANAGED, { affinity: { nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [prefer('node-d')] }, podAffinity: HA_SHARED_VOLUME_AFFINITY } }),
  workload('oauth2-proxy', { app: 'oauth2-proxy' }, { affinity: { nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [prefer('node-d')] } } }),
  workload('file-manager', { 'platform.io/component': 'file-manager' }, { nodeSelector: { [HOST]: 'node-d' } }, 0),
  // Stopped by the tenant: nothing to place now.
  workload('stopped-app', MANAGED, { nodeSelector: { [HOST]: 'node-d' } }, 0),
];

describe('repinTenantPlacement of an HA tenant to a named node', () => {
  const TENANT = {
    tenantId: 't1', namespace: 'tenant-acme', pvcs: [{ volumeName: 'pvc-1' }], storageTier: 'ha',
    // As the drain impact lists them: only the hard-pinned one.
    workloads: [{ kind: 'Deployment' as const, name: 'my-mariadb', pinKind: 'nodeSelector' as const }],
  };
  const tag = async (t: string) => `node-${t}`;
  const bodyOf = (c: ReturnType<typeof cluster>, name: string) =>
    (c.calls.find((x) => x.name === name)?.body as { spec: { template: { spec: Record<string, unknown> } } } | undefined)?.spec.template.spec;

  it('off a live node: every app gets the soft render, the running apps are kept off it, the file manager is pinned', async () => {
    const c = cluster(movedTenantShape());
    const counts = await repinTenantPlacement(c.k8s, c.db, TENANT, 'node-a', 'node-d', tag);

    const spec = (name: string) => applyMergePatch(movedTenantShape().find((w) => w.metadata.name === name)!.spec.template.spec, bodyOf(c, name));
    const keptOff = { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [notIn('node-d')] }] } };
    for (const app of ['my-mariadb', 'artcraft']) {
      expect(spec(app)).toEqual({ affinity: {
        nodeAffinity: { ...keptOff, preferredDuringSchedulingIgnoredDuringExecution: [prefer('node-a')] },
        podAffinity: HA_SHARED_VOLUME_AFFINITY,
      } });
    }
    // No keep-together preference to be pulled back by, and no pod to place:
    // neither is kept off the node, so no exclusion outlives the move.
    expect(spec('oauth2-proxy')).toEqual({ affinity: {
      nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [prefer('node-a')] },
    } });
    expect(spec('stopped-app')).toEqual({ affinity: {
      nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [prefer('node-a')] },
      podAffinity: HA_SHARED_VOLUME_AFFINITY,
    } });
    expect(bodyOf(c, 'file-manager')).toEqual({ nodeSelector: { [HOST]: 'node-a' } });
    // The kubelet is alive: nothing is force-deleted.
    expect(c.calls.some((x) => x.op === 'delete-pod')).toBe(false);
    expect(counts.workloads).toBe(4);
  });

  it('off a dead node: no exclusion is left behind, and the stranded pods are deleted after the patch', async () => {
    const c = cluster(movedTenantShape(), { nodeReady: false, podsOnNode: [podOf('my-mariadb')] });
    await repinTenantPlacement(c.k8s, c.db, TENANT, 'node-a', 'node-d', tag);
    const body = bodyOf(c, 'my-mariadb') as { affinity: { nodeAffinity: Record<string, unknown> } };
    expect(body.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution).toBeUndefined();
    const order = c.calls.map((x) => `${x.op}:${x.name}`);
    expect(order.indexOf('delete-pod:my-mariadb-abc12-xyz')).toBeGreaterThan(order.indexOf('patch:my-mariadb'));
  });

  it('patches the StatefulSets in the namespace too', async () => {
    const c = cluster([], { statefulSets: [workload('db', MANAGED, { nodeSelector: { [HOST]: 'node-d' } })] });
    await repinTenantPlacement(c.k8s, c.db, { ...TENANT, workloads: [] }, 'node-a', 'node-d', tag);
    expect(c.calls.map((x) => `${x.op}:${x.name}`)).toContain('patch-sts:db');
  });

  it('leaves the volume with no node tag: one tag would fence both copies onto the target', async () => {
    const c = cluster(movedTenantShape());
    await repinTenantPlacement(c.k8s, c.db, TENANT, 'node-a', 'node-d', tag);
    // Also clears a tag an earlier move left.
    expect(c.calls.filter((x) => x.op === 'patch-volumes')).toEqual([
      { op: 'patch-volumes', name: 'pvc-1', body: { spec: { nodeSelector: [] } } },
    ]);
  });

  it('a Local tenant still gets the hostname pin, and its volume the node tag', async () => {
    const c = cluster(movedTenantShape());
    await repinTenantPlacement(c.k8s, c.db, { ...TENANT, storageTier: 'local' }, 'node-a', 'node-d', tag);
    expect(bodyOf(c, 'my-mariadb')).toEqual({ nodeSelector: { [HOST]: 'node-a' } });
    expect(bodyOf(c, 'artcraft')).toBeUndefined();
    expect(c.calls.find((x) => x.op === 'patch-volumes')?.body).toEqual({ spec: { nodeSelector: ['node-node-a'] } });
  });
});

describe('repinDeployments (the Storage card\'s move) of an HA tenant', () => {
  it('renders the target softly, keeps no node off, pins the file manager, and counts the running apps', async () => {
    const c = cluster(movedTenantShape());
    const running = await repinDeployments(c.k8s, 'tenant-acme', 'node-a', { restart: false, storageTier: 'ha' });
    const body = c.calls.find((x) => x.name === 'my-mariadb')?.body as { spec: { template: { spec: Record<string, unknown> } } };
    expect(applyMergePatch(movedTenantShape()[0]!.spec.template.spec, body.spec.template.spec)).toEqual({ affinity: {
      nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [prefer('node-a')] },
      podAffinity: HA_SHARED_VOLUME_AFFINITY,
    } });
    expect(c.calls.find((x) => x.name === 'file-manager')?.body).toEqual({
      spec: { template: { spec: { nodeSelector: { [HOST]: 'node-a' } } } },
    });
    // Three apps at 1 replica; the file manager idles at 0.
    expect(running).toBe(3);
  });

  it('with restart, stamps every app so it is placed again', async () => {
    const c = cluster(movedTenantShape());
    await repinDeployments(c.k8s, 'tenant-acme', 'node-a', { restart: true, storageTier: 'ha' });
    for (const app of ['my-mariadb', 'artcraft', 'oauth2-proxy']) {
      const body = c.calls.find((x) => x.name === app)?.body as { spec: { template: { metadata?: { annotations?: Record<string, string> } } } };
      expect(body.spec.template.metadata?.annotations?.['insula.host/restarted-at']).toBeTruthy();
    }
  });

  it('throws when an app cannot be placed, so the caller puts the volumes back', async () => {
    const c = cluster(movedTenantShape(), { failPatch: 'artcraft' });
    await expect(repinDeployments(c.k8s, 'tenant-acme', 'node-a', { restart: false, storageTier: 'ha' }))
      .rejects.toThrow(/Deployment\/artcraft/);
  });
});

describe('pinHaTenantSoftly', () => {
  it('reports a workload it could not patch and patches the others', async () => {
    const c = cluster(movedTenantShape(), { failPatch: 'my-mariadb' });
    const r = await pinHaTenantSoftly(c.k8s, 'tenant-acme', 'node-a', { keepOff: null, statefulSets: false });
    expect(r.patched).toEqual(['Deployment/artcraft', 'Deployment/oauth2-proxy', 'Deployment/stopped-app']);
    expect(r.failed.map((f) => f.workload)).toEqual(['Deployment/my-mariadb']);
  });
});

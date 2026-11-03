import { describe, expect, it } from 'vitest';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { deploymentOfPod, ensureHaColocation, haColocationAffinityPatch } from './ha-colocation.js';
import { HA_SHARED_VOLUME_AFFINITY } from './pod-placement.js';
import { repinTenantPlacement } from '../nodes/service.js';

/**
 * An HA tenant deployed before the keep-together preference existed has none,
 * and an upgrade does not add it. Production: an HA tenant with nine
 * Deployments on one volume, pinned to a node about to restart. Auto-repin
 * force-deletes the stranded pods, and they came back from their old template,
 * each placed on its own.
 */
const prefer = (node: string) => ({
  weight: 100,
  preference: { matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [node] }] },
});
const MANAGED = { 'platform.io/managed': 'true' };

describe('haColocationAffinityPatch', () => {
  it('adds the preference and drops the soft preference for the node being left', () => {
    expect(haColocationAffinityPatch({ nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [prefer('sv4')] } }, 'sv4'))
      .toEqual({ podAffinity: HA_SHARED_VOLUME_AFFINITY, nodeAffinity: null });
  });

  it('adds the preference to a workload with no affinity', () => {
    expect(haColocationAffinityPatch(undefined, 'sv4')).toEqual({ podAffinity: HA_SHARED_VOLUME_AFFINITY });
  });

  it('keeps every other node rule', () => {
    const required = { nodeSelectorTerms: [{ matchExpressions: [{ key: 'disk', operator: 'In', values: ['ssd'] }] }] };
    const other = { weight: 10, preference: { matchExpressions: [{ key: 'zone', operator: 'In', values: ['a'] }] } };
    expect(haColocationAffinityPatch({
      nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: required, preferredDuringSchedulingIgnoredDuringExecution: [prefer('sv4'), other] },
    }, 'sv4')).toEqual({ podAffinity: HA_SHARED_VOLUME_AFFINITY, nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [other] } });
    expect(haColocationAffinityPatch({
      nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: required, preferredDuringSchedulingIgnoredDuringExecution: [prefer('sv4')] },
    }, 'sv4')).toEqual({ podAffinity: HA_SHARED_VOLUME_AFFINITY, nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: null } });
  });

  it('keeps a preference for another node', () => {
    expect(haColocationAffinityPatch({
      nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [prefer('sv1')] }, podAffinity: HA_SHARED_VOLUME_AFFINITY,
    }, 'sv4')).toBeNull();
  });

  it('changes nothing on a workload that already has it, read back with undefined fields', () => {
    // As @kubernetes/client-node deserializes: every absent field an undefined property.
    const typed = JSON.parse(JSON.stringify(HA_SHARED_VOLUME_AFFINITY)) as {
      preferredDuringSchedulingIgnoredDuringExecution: Array<{ podAffinityTerm: Record<string, unknown> }>;
    };
    for (const t of typed.preferredDuringSchedulingIgnoredDuringExecution) {
      Object.assign(t.podAffinityTerm, { namespaces: undefined, namespaceSelector: undefined, matchLabelKeys: undefined });
    }
    expect(haColocationAffinityPatch({ podAffinity: typed }, 'sv4')).toBeNull();
  });
});

/** A pod of Deployment `deploy`, as the cluster lists it. */
const podOf = (deploy: string, hash = 'abc12') => ({
  metadata: {
    name: `${deploy}-${hash}-xyz`,
    labels: { 'pod-template-hash': hash },
    ownerReferences: [{ kind: 'ReplicaSet', name: `${deploy}-${hash}` }],
  },
});

function cluster(items: unknown[], opts: { nodeReady?: boolean; podsOnNode?: unknown[] } = {}) {
  const calls: Array<{ op: string; name: string; body?: unknown }> = [];
  const k8s = {
    core: {
      readNode: async () => ({ status: { conditions: [{ type: 'Ready', status: opts.nodeReady === false ? 'Unknown' : 'True' }] } }),
      listNamespacedPod: async () => ({ items: opts.podsOnNode ?? [] }),
      deleteNamespacedPod: async ({ name }: { name: string }) => { calls.push({ op: 'delete-pod', name }); return {}; },
    },
    apps: {
      listNamespacedDeployment: async () => ({ items }),
      readNamespacedDeployment: async ({ name }: { name: string }) => ({
        spec: { template: { spec: (items as Array<{ metadata: { name: string }; spec: { template: { spec: unknown } } }>)
          .find((d) => d.metadata.name === name)?.spec.template.spec } },
      }),
      patchNamespacedDeployment: async ({ name, body }: { name: string; body: unknown }) => {
        calls.push({ op: 'patch', name, body });
        return {};
      },
    },
    custom: { patchNamespacedCustomObject: async () => ({}) },
  } as unknown as K8sClients;
  const db = { update: () => ({ set: () => ({ where: async () => undefined }) }) } as unknown as Database;
  return { k8s, db, calls };
}

const deployment = (name: string, labels: Record<string, string>, affinity?: unknown, nodeSelector?: Record<string, string>) => ({
  metadata: { name },
  spec: { template: { metadata: { labels }, spec: { ...(affinity === undefined ? {} : { affinity }), ...(nodeSelector ? { nodeSelector } : {}) } } },
});
const preferS4 = { nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [prefer('sv4')] } };

describe('deploymentOfPod', () => {
  it('names the Deployment from the ReplicaSet and the template hash', () => {
    expect(deploymentOfPod(podOf('my-mariadb'))).toBe('my-mariadb');
    expect(deploymentOfPod({ metadata: { ownerReferences: [{ kind: 'StatefulSet', name: 'db' }] } })).toBeNull();
    expect(deploymentOfPod({ metadata: { labels: { 'pod-template-hash': 'zz' }, ownerReferences: [{ kind: 'ReplicaSet', name: 'odd' }] } })).toBeNull();
  });
});

describe('ensureHaColocation', () => {
  it('patches the tenant workloads with a pod on the node, only those that need it', async () => {
    const c = cluster([
      deployment('website', MANAGED, preferS4),
      deployment('db', MANAGED, { podAffinity: HA_SHARED_VOLUME_AFFINITY }),
      deployment('crm', MANAGED, preferS4),
      deployment('file-manager', { app: 'file-manager', 'platform.io/component': 'file-manager' }),
      deployment('oauth2-proxy', { app: 'oauth2-proxy' }),
    ], { podsOnNode: [podOf('website'), podOf('db'), podOf('file-manager'), podOf('oauth2-proxy')] });
    // crm runs elsewhere: restarting it would move nothing.
    expect(await ensureHaColocation(c.k8s, 'tenant-acme', 'sv4')).toEqual(['website']);
    expect(c.calls).toEqual([{
      op: 'patch', name: 'website',
      body: { spec: { template: { spec: { affinity: { podAffinity: HA_SHARED_VOLUME_AFFINITY, nodeAffinity: null } } } } },
    }]);
  });

  it('skips what the caller already patched, and does nothing with no pod on the node', async () => {
    const items = [deployment('website', MANAGED, preferS4)];
    const skipped = cluster(items, { podsOnNode: [podOf('website')] });
    expect(await ensureHaColocation(skipped.k8s, 'tenant-acme', 'sv4', new Set(['website']))).toEqual([]);
    const none = cluster(items);
    expect(await ensureHaColocation(none.k8s, 'tenant-acme', 'sv4')).toEqual([]);
    expect([...skipped.calls, ...none.calls]).toEqual([]);
  });

  it('never throws on an unreadable namespace', async () => {
    const k8s = { core: { listNamespacedPod: async () => { throw new Error('boom'); } } } as unknown as K8sClients;
    expect(await ensureHaColocation(k8s, 'tenant-acme', 'sv4')).toEqual([]);
  });
});

describe('repinTenantPlacement of an HA tenant to Auto', () => {
  const TENANT = {
    tenantId: 't1', namespace: 'tenant-acme', workloads: [] as Array<{ kind: 'Deployment'; name: string; pinKind: 'nodeSelector' | 'nodeAffinity' }>,
    pvcs: [{ volumeName: 'pvc-1' }], storageTier: 'ha',
  };
  const tag = async (t: string) => `node-${t}`;
  const items = [deployment('website', MANAGED, preferS4), deployment('crm', MANAGED, preferS4)];

  it('off a dead node: its workloads get the preference before the stranded pods are deleted', async () => {
    const c = cluster(items, { nodeReady: false, podsOnNode: [podOf('website'), podOf('crm')] });
    const counts = await repinTenantPlacement(c.k8s, c.db, TENANT, '', 'sv4', tag);
    expect(c.calls.map((x) => `${x.op}:${x.name}`)).toEqual([
      'patch:file-manager', 'patch:website', 'patch:crm', 'delete-pod:website-abc12-xyz', 'delete-pod:crm-abc12-xyz',
    ]);
    expect(counts.workloads).toBe(2);
    expect(counts.evictedPods).toBe(2);
  });

  it('a hard-pinned workload gets it in its one pin patch, not a second one', async () => {
    const pinned = deployment('db', MANAGED, undefined, { 'kubernetes.io/hostname': 'sv4' });
    const c = cluster([pinned], { nodeReady: false, podsOnNode: [podOf('db')] });
    const counts = await repinTenantPlacement(c.k8s, c.db, {
      ...TENANT, workloads: [{ kind: 'Deployment', name: 'db', pinKind: 'nodeSelector' }],
    }, '', 'sv4', tag);
    expect(c.calls.filter((x) => x.op === 'patch' && x.name === 'db')).toEqual([{
      op: 'patch', name: 'db',
      body: { spec: { template: { spec: { affinity: { podAffinity: HA_SHARED_VOLUME_AFFINITY }, nodeSelector: { 'kubernetes.io/hostname': null } } } } },
    }]);
    expect(counts.workloads).toBe(1);
  });

  it('a stripped nodeAffinity pin keeps its other rules next to the preference', async () => {
    const anti = { preferredDuringSchedulingIgnoredDuringExecution: [{ weight: 1, podAffinityTerm: { labelSelector: { matchLabels: { x: 'y' } }, topologyKey: 'zone' } }] };
    const pinned = deployment('db', MANAGED, {
      podAntiAffinity: anti,
      nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: {
        nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: ['sv4'] }] }],
      } },
    });
    const c = cluster([pinned], { nodeReady: false });
    await repinTenantPlacement(c.k8s, c.db, {
      ...TENANT, workloads: [{ kind: 'Deployment', name: 'db', pinKind: 'nodeAffinity' }],
    }, '', 'sv4', tag);
    expect(c.calls.find((x) => x.name === 'db')?.body).toEqual({
      spec: { template: { spec: { affinity: { nodeAffinity: null, podAntiAffinity: anti, podAffinity: HA_SHARED_VOLUME_AFFINITY }, nodeSelector: { 'kubernetes.io/hostname': null } } } },
    });
  });

  it('off a live node (a drain, the wizard) it leaves the templates alone: the drain does it once the node is blocked', async () => {
    const c = cluster(items, { podsOnNode: [podOf('website'), podOf('crm')] });
    await repinTenantPlacement(c.k8s, c.db, TENANT, '', 'sv4', tag);
    expect(c.calls.map((x) => `${x.op}:${x.name}`)).toEqual(['patch:file-manager']);
  });

  it('leaves a Local tenant and a re-pin to a named node alone', async () => {
    const local = cluster(items, { nodeReady: false, podsOnNode: [podOf('website')] });
    await repinTenantPlacement(local.k8s, local.db, { ...TENANT, storageTier: 'local' }, 'sv1', 'sv4', tag);
    const named = cluster(items, { nodeReady: false, podsOnNode: [podOf('website')] });
    await repinTenantPlacement(named.k8s, named.db, TENANT, 'sv1', 'sv4', tag);
    for (const c of [local, named]) {
      expect(c.calls.filter((x) => x.op === 'patch' && x.name === 'website')).toEqual([]);
    }
  });
});

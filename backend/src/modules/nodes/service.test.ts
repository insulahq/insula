import { describe, it, expect, vi } from 'vitest';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  buildDrainImpact,
  countOtherSchedulableTenantNodes,
  deleteNode,
  drainNode,
  listNodesEnriched,
  updateNode,
} from './service.js';

// Schema mock so the dynamic import inside service.ts doesn't blow up.
// `clusterNodes` is used by listNodes() (static import); the rest are
// dynamically imported inside buildDrainImpact.
vi.mock('../../db/schema.js', () => ({
  clusterNodes: {
    name: 'cluster_nodes.name',
    role: 'cluster_nodes.role',
  },
  tenants: {
    id: 'tenants.id',
    name: 'tenants.name',
    kubernetesNamespace: 'tenants.kubernetesNamespace',
    storageTier: 'tenants.storageTier',
    nodeName: 'tenants.nodeName',
  },
}));

interface MockTenantRow {
  id: string;
  name: string;
  ns: string | null;
  tier?: 'local' | 'ha';
  pin?: string | null;
}
function makeMockDb(tenantRows: MockTenantRow[]): Database {
  return {
    select: () => ({
      from: () => Promise.resolve(
        tenantRows.map((r) => ({
          id: r.id,
          name: r.name,
          ns: r.ns,
          tier: r.tier ?? 'local',
          pin: r.pin ?? null,
        })),
      ),
    }),
  } as unknown as Database;
}

function makeK8s(opts: {
  unschedulable?: boolean;
  pods?: unknown[];
  deployments?: unknown[];
  statefulsets?: unknown[];
  longhornVolumes?: unknown[];
  longhornReplicas?: unknown[];
}): K8sClients {
  return {
    core: {
      readNode: vi.fn().mockResolvedValue({ spec: { unschedulable: opts.unschedulable ?? false } }),
      listPodForAllNamespaces: vi.fn().mockResolvedValue({ items: opts.pods ?? [] }),
    },
    apps: {
      listDeploymentForAllNamespaces: vi.fn().mockResolvedValue({ items: opts.deployments ?? [] }),
      listStatefulSetForAllNamespaces: vi.fn().mockResolvedValue({ items: opts.statefulsets ?? [] }),
    },
    custom: {
      listNamespacedCustomObject: vi.fn().mockImplementation(async (req: { plural: string }) => {
        if (req.plural === 'replicas') return { items: opts.longhornReplicas ?? [] };
        if (req.plural === 'volumes') return { items: opts.longhornVolumes ?? [] };
        return { items: [] };
      }),
    },
  } as unknown as K8sClients;
}

describe('buildDrainImpact', () => {
  it('surfaces a Deployment pinned via nodeSelector even when replicas=0', async () => {
    // Real-world repro: tenant deployment scaled to 0 (e.g. as a workaround
    // for FM PVC contention) but its template still pins to the worker.
    // The previous version listed pods on the node and missed the Deployment
    // entirely — the operator would see "0 non-system pods" and drain
    // without realising a pinned workload had to be re-targeted.
    const k8s = makeK8s({
      pods: [],
      deployments: [{
        metadata: { name: 'nginx-php', namespace: 'tenant-foo' },
        spec: {
          replicas: 0,
          template: { spec: { nodeSelector: { 'kubernetes.io/hostname': 'worker' } } },
        },
      }],
    });
    const db = makeMockDb([
      { id: 'tenant-foo-id', name: 'Foo Co', ns: 'tenant-foo' },
    ]);

    const impact = await buildDrainImpact(k8s, db, 'worker');

    // Pinning is exposed as a per-tenant aggregate now — the modal
    // shows tenants (not workloads) and re-pins one tenant at a time.
    expect(impact.pinnedTenants).toHaveLength(1);
    expect(impact.pinnedTenants[0]).toMatchObject({
      tenantId: 'tenant-foo-id',
      tenantName: 'Foo Co',
      namespace: 'tenant-foo',
    });
    expect(impact.pinnedTenants[0].workloads).toHaveLength(1);
    expect(impact.pinnedTenants[0].workloads[0]).toMatchObject({
      kind: 'Deployment',
      name: 'nginx-php',
      pinKind: 'nodeSelector',
      replicas: 0,
    });
  });

  it('attributes pods to tenants via namespace lookup when label is missing', async () => {
    const k8s = makeK8s({
      pods: [{
        metadata: {
          namespace: 'tenant-bar',
          name: 'web-1-abcde',
          ownerReferences: [{ kind: 'ReplicaSet', name: 'web-1' }],
        },
        spec: { nodeName: 'worker' },
        status: { phase: 'Running' },
      }],
    });
    const db = makeMockDb([
      { id: 'tenant-bar-id', name: 'Bar Co', ns: 'tenant-bar' },
    ]);

    const impact = await buildDrainImpact(k8s, db, 'worker');

    expect(impact.nonSystemPods).toHaveLength(1);
    expect(impact.nonSystemPods[0]).toMatchObject({
      namespace: 'tenant-bar',
      name: 'web-1-abcde',
      tenantId: 'tenant-bar-id',
      tenantName: 'Bar Co',
      workloadKind: 'ReplicaSet',
      workloadName: 'web-1',
    });
  });

  it('detects nodeAffinity-based pin (not just nodeSelector)', async () => {
    const k8s = makeK8s({
      pods: [],
      statefulsets: [{
        metadata: { name: 'db', namespace: 'tenant-baz' },
        spec: {
          replicas: 1,
          template: {
            spec: {
              affinity: {
                nodeAffinity: {
                  requiredDuringSchedulingIgnoredDuringExecution: {
                    nodeSelectorTerms: [{
                      matchExpressions: [{
                        key: 'kubernetes.io/hostname',
                        operator: 'In',
                        values: ['worker'],
                      }],
                    }],
                  },
                },
              },
            },
          },
        },
      }],
    });
    const db = makeMockDb([{ id: 'tenant-baz-id', name: 'Baz Co', ns: 'tenant-baz' }]);

    const impact = await buildDrainImpact(k8s, db, 'worker');
    expect(impact.pinnedTenants).toHaveLength(1);
    expect(impact.pinnedTenants[0].workloads).toHaveLength(1);
    expect(impact.pinnedTenants[0].workloads[0].pinKind).toBe('nodeAffinity');
    expect(impact.pinnedTenants[0].workloads[0].kind).toBe('StatefulSet');
  });

  it('flags tenant PVCs with a replica on the draining node', async () => {
    const k8s = makeK8s({
      pods: [],
      longhornVolumes: [{
        metadata: { name: 'pvc-foo' },
        spec: { size: String(10 * 1024 ** 3), numberOfReplicas: 1, nodeSelector: [] },
        status: { kubernetesStatus: { pvcName: 'data', namespace: 'tenant-foo' } },
      }],
      longhornReplicas: [{
        spec: { volumeName: 'pvc-foo', nodeID: 'worker' },
        status: { currentState: 'running' },
      }],
    });
    const db = makeMockDb([{ id: 'tenant-foo-id', name: 'Foo Co', ns: 'tenant-foo' }]);

    const impact = await buildDrainImpact(k8s, db, 'worker');
    expect(impact.pinnedTenants).toHaveLength(1);
    expect(impact.pinnedTenants[0]).toMatchObject({
      tenantId: 'tenant-foo-id',
      tenantName: 'Foo Co',
      namespace: 'tenant-foo',
    });
    expect(impact.pinnedTenants[0].pvcs).toHaveLength(1);
    expect(impact.pinnedTenants[0].pvcs[0]).toMatchObject({
      pvcName: 'data',
      volumeName: 'pvc-foo',
      replicaCount: 1,
      isLastReplica: true,
    });
  });

  it('classifies pods in cluster-infra namespaces (calico, kube-system) as system', async () => {
    // Repro: Calico's calico-kube-controllers (Deployment-backed pod in
    // calico-system) was previously surfaced as a tenant pod because
    // the namespace wasn't in SYSTEM_NAMESPACES. Same hazard for kube-system,
    // tigera-operator, cnpg-system, monitoring.
    const k8s = makeK8s({
      pods: [
        {
          metadata: { namespace: 'calico-system', name: 'calico-kube-controllers-abcde', ownerReferences: [{ kind: 'ReplicaSet', name: 'calico-kube-controllers' }] },
          spec: { nodeName: 'worker' },
          status: { phase: 'Running' },
        },
        {
          metadata: { namespace: 'tigera-operator', name: 'tigera-operator-xyz', ownerReferences: [{ kind: 'ReplicaSet', name: 'tigera-operator' }] },
          spec: { nodeName: 'worker' },
          status: { phase: 'Running' },
        },
        {
          metadata: { namespace: 'kube-system', name: 'coredns-1', ownerReferences: [{ kind: 'ReplicaSet', name: 'coredns' }] },
          spec: { nodeName: 'worker' },
          status: { phase: 'Running' },
        },
        {
          metadata: { namespace: 'cnpg-system', name: 'cnpg-controller-1', ownerReferences: [{ kind: 'ReplicaSet', name: 'cnpg-controller-manager' }] },
          spec: { nodeName: 'worker' },
          status: { phase: 'Running' },
        },
      ],
    });
    const db = makeMockDb([]);

    const impact = await buildDrainImpact(k8s, db, 'worker');

    expect(impact.nonSystemPods).toHaveLength(0);
    const sysNs = impact.systemPods.map((p) => p.namespace).sort();
    expect(sysNs).toEqual(['calico-system', 'cnpg-system', 'kube-system', 'tigera-operator']);
  });

  it('enriches longhornReplicas with PVC + owner attribution (tenant + platform-system)', async () => {
    // Two replicas live on `worker`: one tenant volume (Acme/data) and one
    // platform volume (postgres-1 in cnpg-system). Both should land in
    // longhornReplicas with ownerLabel populated; the tenant replica also
    // resolves tenantId/tenantName.
    const k8s = makeK8s({
      longhornVolumes: [
        {
          metadata: { name: 'pvc-acme-data' },
          status: { kubernetesStatus: { pvcName: 'data', namespace: 'tenant-acme' } },
        },
        {
          metadata: { name: 'pvc-postgres-1' },
          status: { kubernetesStatus: { pvcName: 'postgres-1', namespace: 'platform' } },
        },
      ],
      longhornReplicas: [
        { metadata: { name: 'r-acme-data-1' }, spec: { volumeName: 'pvc-acme-data', nodeID: 'worker' }, status: { currentState: 'running' } },
        { metadata: { name: 'r-postgres-1-w' }, spec: { volumeName: 'pvc-postgres-1', nodeID: 'worker' }, status: { currentState: 'running' } },
      ],
    });
    const db = makeMockDb([{ id: 'acme-id', name: 'Acme Co', ns: 'tenant-acme' }]);

    const impact = await buildDrainImpact(k8s, db, 'worker');

    expect(impact.longhornReplicas).toHaveLength(2);
    const acme = impact.longhornReplicas.find((r) => r.volumeName === 'pvc-acme-data');
    expect(acme).toMatchObject({
      pvcName: 'data',
      namespace: 'tenant-acme',
      tenantId: 'acme-id',
      tenantName: 'Acme Co',
      ownerLabel: 'Acme Co',
      isLastReplica: true,
    });
    const pg = impact.longhornReplicas.find((r) => r.volumeName === 'pvc-postgres-1');
    expect(pg).toMatchObject({
      pvcName: 'postgres-1',
      namespace: 'platform',
      tenantId: null,
      tenantName: null,
      ownerLabel: 'Platform System (platform)',
      isLastReplica: true,
    });
  });

  it('a detached volume\'s stopped copies count — a retained 3-replica volume is not a last replica', async () => {
    // Longhorn keeps every replica of a detached volume `stopped`. Counting
    // only running replicas made it read as zero copies, so the retained
    // CrowdSec store blocked the drain of every server holding one.
    const k8s = makeK8s({
      longhornVolumes: [{
        metadata: { name: 'pvc-crowdsec' },
        status: { state: 'detached', kubernetesStatus: { pvcName: 'crowdsec-data', namespace: 'crowdsec' } },
      }],
      longhornReplicas: ['s1', 's2', 's3'].map((n) => ({
        metadata: { name: `r-crowdsec-${n}` },
        spec: { volumeName: 'pvc-crowdsec', nodeID: n, failedAt: '' },
        status: { currentState: 'stopped' },
      })),
    });
    const impact = await buildDrainImpact(k8s, makeMockDb([]), 's2');
    expect(impact.longhornReplicas).toEqual([expect.objectContaining({ pvcName: 'crowdsec-data', isLastReplica: false })]);
  });

  it('a detached volume whose other copies failed is still a last replica here', async () => {
    const k8s = makeK8s({
      longhornVolumes: [{
        metadata: { name: 'pvc-crowdsec' },
        status: { state: 'detached', kubernetesStatus: { pvcName: 'crowdsec-data', namespace: 'crowdsec' } },
      }],
      longhornReplicas: ['s1', 's2', 's3'].map((n) => ({
        metadata: { name: `r-crowdsec-${n}` },
        spec: { volumeName: 'pvc-crowdsec', nodeID: n, failedAt: n === 's2' ? '' : '2026-10-17T10:00:00Z' },
        status: { currentState: 'stopped' },
      })),
    });
    const impact = await buildDrainImpact(k8s, makeMockDb([]), 's2');
    expect(impact.longhornReplicas).toEqual([expect.objectContaining({ pvcName: 'crowdsec-data', isLastReplica: true })]);
  });

  it('a failed leftover replica here next to a healthy copy elsewhere is not the last copy', async () => {
    const k8s = makeK8s({
      longhornVolumes: [{
        metadata: { name: 'pvc-mon' },
        status: { state: 'attached', kubernetesStatus: { pvcName: 'vmsingle-storage', namespace: 'monitoring' } },
      }],
      longhornReplicas: [
        { metadata: { name: 'r-here' }, spec: { volumeName: 'pvc-mon', nodeID: 'worker', failedAt: '2026-10-17T10:00:00Z' }, status: { currentState: 'error' } },
        { metadata: { name: 'r-there' }, spec: { volumeName: 'pvc-mon', nodeID: 'other' }, status: { currentState: 'running' } },
      ],
    });
    const impact = await buildDrainImpact(k8s, makeMockDb([]), 'worker');
    expect(impact.longhornReplicas).toEqual([expect.objectContaining({ replicaName: 'r-here', isLastReplica: false })]);
  });

  it('skips system namespaces from pinnedWorkloads enumeration', async () => {
    const k8s = makeK8s({
      deployments: [{
        metadata: { name: 'platform-api', namespace: 'platform' },
        spec: {
          replicas: 1,
          template: { spec: { nodeSelector: { 'kubernetes.io/hostname': 'worker' } } },
        },
      }],
    });
    const db = makeMockDb([]);

    const impact = await buildDrainImpact(k8s, db, 'worker');
    // No pinned tenant tenants on the node — system-namespace
    // workloads are filtered out before aggregation.
    expect(impact.pinnedTenants).toHaveLength(0);
  });
});

interface MockNodeRow {
  name: string;
  role?: 'server' | 'worker';
  /** Defaults to true — mirrors the clusterNodes column default. */
  canHost?: boolean;
}
function makeListNodesDb(rows: MockNodeRow[]): Database {
  // Drizzle chain: db.select().from(clusterNodes).orderBy(desc(role), name)
  return {
    select: () => ({
      from: () => ({
        orderBy: () => Promise.resolve(rows.map((r) => ({
          name: r.name,
          role: r.role ?? 'worker',
          canHostTenantWorkloads: r.canHost ?? true,
        }))),
      }),
    }),
  } as unknown as Database;
}

function makeK8sListNodes(observedNames: string[] | 'fail'): K8sClients {
  const listNodeImpl = observedNames === 'fail'
    ? vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'))
    : vi.fn().mockResolvedValue({
      items: observedNames.map((name) => ({ metadata: { name }, spec: { unschedulable: false } })),
    });
  return {
    core: {
      listNode: listNodeImpl,
      listPodForAllNamespaces: vi.fn().mockResolvedValue({ items: [] }),
    },
    custom: {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
    },
  } as unknown as K8sClients;
}

describe('listNodesEnriched — orphan detection', () => {
  it('marks DB rows missing from kubectl get nodes as orphaned (existsInKubernetes=false)', async () => {
    // Real-world repro: an operator ran `kubectl delete node staging-3`
    // out-of-band, but the platform DB still has the row because the
    // 60s reconciler only upserts — it never deletes stale rows. The
    // UI must surface this so the operator can remove the orphan.
    const db = makeListNodesDb([
      { name: 'staging-1' },
      { name: 'staging-2' },
      { name: 'orphan-3' }, // gone from k8s
    ]);
    const k8s = makeK8sListNodes(['staging-1', 'staging-2']);

    const enriched = await listNodesEnriched(db, k8s);

    const byName = new Map(enriched.map((n) => [n.name, n]));
    expect(byName.get('staging-1')?.existsInKubernetes).toBe(true);
    expect(byName.get('staging-2')?.existsInKubernetes).toBe(true);
    expect(byName.get('orphan-3')?.existsInKubernetes).toBe(false);
  });

  it('treats every row as live when no K8s tenant is supplied (test/cold-start mode)', async () => {
    const db = makeListNodesDb([{ name: 'staging-1' }]);
    const enriched = await listNodesEnriched(db, null);
    expect(enriched[0].existsInKubernetes).toBe(true);
  });

  it('does not flip every row to orphaned on a transient listNode() failure', async () => {
    // safeCall() swallows the error and returns { items: [] }. If we
    // naively set existsInKubernetes = observedNames.has(name), a 30s
    // API blip would paint the entire fleet as orphaned and tempt the
    // operator to delete healthy rows.
    const db = makeListNodesDb([
      { name: 'staging-1' },
      { name: 'staging-2' },
    ]);
    const k8s = makeK8sListNodes('fail');

    const enriched = await listNodesEnriched(db, k8s);

    expect(enriched).toHaveLength(2);
    for (const n of enriched) {
      expect(n.existsInKubernetes).toBe(true);
    }
  });
});

interface LiveNodeOpt {
  name: string;
  unschedulable?: boolean;
  notReady?: boolean;
}
function liveNode(n: LiveNodeOpt) {
  return {
    metadata: { name: n.name },
    spec: { unschedulable: n.unschedulable ?? false },
    status: { conditions: [{ type: 'Ready', status: n.notReady ? 'False' : 'True' }] },
  };
}

describe('countOtherSchedulableTenantNodes (drain guard #0 predicate)', () => {
  const dbTwo = [
    { name: 'a', canHostTenantWorkloads: true },
    { name: 'b', canHostTenantWorkloads: true },
  ];

  it('counts a healthy, Ready, uncordoned, tenant-capable peer', () => {
    expect(countOtherSchedulableTenantNodes('a', dbTwo, [liveNode({ name: 'a' }), liveNode({ name: 'b' })])).toBe(1);
  });

  it('returns 0 on a single-node cluster (only node is the drain target)', () => {
    expect(countOtherSchedulableTenantNodes('solo', [{ name: 'solo', canHostTenantWorkloads: true }], [liveNode({ name: 'solo' })])).toBe(0);
  });

  it('excludes a cordoned peer', () => {
    expect(countOtherSchedulableTenantNodes('a', dbTwo, [liveNode({ name: 'a' }), liveNode({ name: 'b', unschedulable: true })])).toBe(0);
  });

  it('excludes a NotReady peer (degraded node is not safe schedulable surface)', () => {
    expect(countOtherSchedulableTenantNodes('a', dbTwo, [liveNode({ name: 'a' }), liveNode({ name: 'b', notReady: true })])).toBe(0);
  });

  it('excludes a peer the DB flags non-tenant-capable (control-plane-only)', () => {
    const db = [{ name: 'a', canHostTenantWorkloads: true }, { name: 'cp', canHostTenantWorkloads: false }];
    expect(countOtherSchedulableTenantNodes('a', db, [liveNode({ name: 'a' }), liveNode({ name: 'cp' })])).toBe(0);
  });

  it('excludes a live node unknown to the platform DB (fail closed)', () => {
    expect(countOtherSchedulableTenantNodes('a', [{ name: 'a', canHostTenantWorkloads: true }], [liveNode({ name: 'a' }), liveNode({ name: 'ghost' })])).toBe(0);
  });

  it('treats a missing Ready condition as not-Ready', () => {
    const live = [liveNode({ name: 'a' }), { metadata: { name: 'b' }, spec: { unschedulable: false }, status: { conditions: [] } }];
    expect(countOtherSchedulableTenantNodes('a', dbTwo, live)).toBe(0);
  });
});

describe('drainNode — last schedulable tenant-capable node guard (#0)', () => {
  // k8s mock driving guard #0's direct core.listNode() read. Pass 'throw'
  // to simulate an unreachable Kubernetes API (fail-closed path).
  function makeK8sNodes(nodes: LiveNodeOpt[] | 'throw'): K8sClients {
    const listNode = nodes === 'throw'
      ? vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'))
      : vi.fn().mockResolvedValue({ items: nodes.map(liveNode) });
    return {
      core: {
        listNode,
        listPodForAllNamespaces: vi.fn().mockResolvedValue({ items: [] }),
      },
      custom: {
        listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
      },
    } as unknown as K8sClients;
  }

  it('refuses to drain the only node (single-node cluster) even with forceLastReplica', async () => {
    const db = makeListNodesDb([{ name: 'solo' }]);
    const k8s = makeK8sNodes([{ name: 'solo' }]);

    await expect(
      drainNode(k8s, db, 'solo', { forceLastReplica: true, tenantPlacement: {} }),
    ).rejects.toMatchObject({ code: 'NODE_DRAIN_BLOCKED_LAST_NODE', status: 409 });
  });

  it('refuses when the only other node is cordoned (no schedulable surface left)', async () => {
    const db = makeListNodesDb([{ name: 'a' }, { name: 'b' }]);
    const k8s = makeK8sNodes([{ name: 'a' }, { name: 'b', unschedulable: true }]);

    await expect(
      drainNode(k8s, db, 'a', { forceLastReplica: true, tenantPlacement: {} }),
    ).rejects.toMatchObject({ code: 'NODE_DRAIN_BLOCKED_LAST_NODE', status: 409 });
  });

  it('refuses when the only other node cannot host tenant workloads', async () => {
    const db = makeListNodesDb([{ name: 'a' }, { name: 'cp', canHost: false }]);
    const k8s = makeK8sNodes([{ name: 'a' }, { name: 'cp' }]);

    await expect(
      drainNode(k8s, db, 'a', { forceLastReplica: true, tenantPlacement: {} }),
    ).rejects.toMatchObject({ code: 'NODE_DRAIN_BLOCKED_LAST_NODE', status: 409 });
  });

  it('fails CLOSED with 503 when the Kubernetes API is unreachable', async () => {
    const db = makeListNodesDb([{ name: 'a' }, { name: 'b' }]);
    const k8s = makeK8sNodes('throw');

    await expect(
      drainNode(k8s, db, 'a', { forceLastReplica: true, tenantPlacement: {} }),
    ).rejects.toMatchObject({ code: 'NODE_DRAIN_PRECHECK_FAILED', status: 503 });
  });

  it('returns 404 when the target node is unknown to the platform', async () => {
    const db = makeListNodesDb([{ name: 'a' }, { name: 'b' }]);
    const k8s = makeK8sNodes([{ name: 'a' }, { name: 'b' }]);

    await expect(
      drainNode(k8s, db, 'ghost', { forceLastReplica: true, tenantPlacement: {} }),
    ).rejects.toMatchObject({ code: 'NODE_NOT_FOUND', status: 404 });
  });
});

// ─── Postgres instances (HA: one Longhorn replica per instance) ──────────
//
// The HA tier gives every CNPG instance's volume ONE Longhorn replica — the
// other instances are the redundancy. The drain must not read that as "the
// last copy of the data" while an instance that stays up holds it: the
// primary for a replica, a standby streaming right now for the primary.
// Deleting the node is another matter: the instance's only copy goes with it.
describe('Postgres instances on a drained / deleted node', () => {
  interface PgInstance {
    name: string;
    node: string;
    ready?: boolean;
    primary?: boolean;
    /** Node holding the instance volume's one replica (defaults to `node`). */
    replicaOn?: string;
  }
  interface Opts {
    cnpgListFails?: boolean;
    cordoned?: string[];
    /** The node under test is cordoned (deleteNode requires it). */
    targetCordoned?: boolean;
  }

  function makeHaK8s(instances: PgInstance[], opts: Opts = {}) {
    const pvcVol = (n: string) => `pvc-${n}`;
    const patchNode = vi.fn().mockResolvedValue({});
    const evict = vi.fn().mockResolvedValue({});
    const deleteK8sNode = vi.fn().mockResolvedValue({});
    const cordoned = new Set(opts.cordoned ?? []);
    const cnpgPods = instances.map((i) => ({
      metadata: {
        namespace: 'platform',
        name: i.name,
        labels: {
          'cnpg.io/cluster': 'system-db',
          'cnpg.io/instanceName': i.name,
          'cnpg.io/instanceRole': i.primary ? 'primary' : 'replica',
        },
      },
      spec: { nodeName: i.node, volumes: [{ persistentVolumeClaim: { claimName: i.name } }] },
      status: { phase: 'Running', conditions: [{ type: 'Ready', status: i.ready === false ? 'False' : 'True' }] },
    }));
    const k8s = {
      core: {
        readNode: vi.fn().mockResolvedValue({ spec: { unschedulable: opts.targetCordoned ?? false } }),
        listNode: vi.fn().mockResolvedValue({
          items: ['s1', 's2', 's3'].map((name) => liveNode({ name, unschedulable: cordoned.has(name) })),
        }),
        listPodForAllNamespaces: vi.fn(async (a: { labelSelector?: string }) => {
          if (a.labelSelector === 'cnpg.io/cluster') {
            if (opts.cnpgListFails) throw new Error('etcdserver: request timed out');
            return { items: cnpgPods };
          }
          return { items: [] };
        }),
        listPersistentVolumeClaimForAllNamespaces: vi.fn(async () => {
          if (opts.cnpgListFails) throw new Error('etcdserver: request timed out');
          return {
            items: instances.map((i) => ({
              metadata: {
                namespace: 'platform',
                name: i.name,
                labels: { 'cnpg.io/cluster': 'system-db', 'cnpg.io/instanceName': i.name },
              },
            })),
          };
        }),
        patchNode,
        createNamespacedPodEviction: evict,
        deleteNode: deleteK8sNode,
      },
      apps: {
        listDeploymentForAllNamespaces: vi.fn().mockResolvedValue({ items: [] }),
        listStatefulSetForAllNamespaces: vi.fn().mockResolvedValue({ items: [] }),
      },
      custom: {
        listNamespacedCustomObject: vi.fn(async (req: { plural: string }) => {
          if (req.plural === 'replicas') {
            return {
              items: instances.map((i) => ({
                metadata: { name: `r-${i.name}` },
                spec: { volumeName: pvcVol(i.name), nodeID: i.replicaOn ?? i.node },
                status: { currentState: 'running' },
              })),
            };
          }
          if (req.plural === 'volumes') {
            return {
              items: instances.map((i) => ({
                metadata: { name: pvcVol(i.name) },
                status: { kubernetesStatus: { pvcName: i.name, namespace: 'platform' } },
              })),
            };
          }
          return { items: [] };
        }),
      },
    } as unknown as K8sClients;
    return { k8s, patchNode, evict, deleteK8sNode };
  }

  // listNodes() chains .orderBy(); buildDrainImpact awaits .from() directly;
  // the primary's pg_stat_replication comes through db.execute.
  function makeDrainDb(streaming: string[] | 'fail' = []): Database {
    const rows = ['s1', 's2', 's3'].map((name) => ({ name, role: 'server', canHostTenantWorkloads: true }));
    return {
      select: () => ({
        from: () => Object.assign(Promise.resolve([]), { orderBy: () => Promise.resolve(rows) }),
      }),
      execute: vi.fn(async () => {
        if (streaming === 'fail') throw new Error('permission denied for view pg_stat_replication');
        return { rows: streaming.map((application_name) => ({ application_name })) };
      }),
    } as unknown as Database;
  }

  const haCluster: PgInstance[] = [
    { name: 'system-db-1', node: 's1', primary: true },
    { name: 'system-db-2', node: 's2' },
    { name: 'system-db-3', node: 's3' },
  ];
  const instanceOn = async (k8s: K8sClients, db: Database, node: string, pvc: string) =>
    (await buildDrainImpact(k8s, db, node)).longhornReplicas.find((r) => r.pvcName === pvc);

  it('a replica on the draining node is covered by the primary elsewhere', async () => {
    const { k8s } = makeHaK8s(haCluster);
    expect(await instanceOn(k8s, makeDrainDb(), 's2', 'system-db-2')).toMatchObject({
      isLastReplica: true,
      postgresInstance: { kind: 'postgres', cluster: 'system-db', instance: 'system-db-2', primary: false, coveredBy: ['system-db-1'] },
    });
  });

  it('the primary is covered by the standbys it is streaming to — and only those', async () => {
    const { k8s } = makeHaK8s(haCluster);
    expect((await instanceOn(k8s, makeDrainDb(['system-db-2', 'system-db-3']), 's1', 'system-db-1'))?.postgresInstance)
      .toMatchObject({ instance: 'system-db-1', primary: true, coveredBy: ['system-db-2', 'system-db-3'] });
    // Both standbys Ready, only one streaming: a Ready pod is not a caught-up copy.
    expect((await instanceOn(k8s, makeDrainDb(['system-db-3']), 's1', 'system-db-1'))?.postgresInstance?.coveredBy)
      .toEqual(['system-db-3']);
    expect((await instanceOn(k8s, makeDrainDb([]), 's1', 'system-db-1'))?.postgresInstance?.coveredBy).toEqual([]);
  });

  it('the primary is not covered when its replication cannot be read', async () => {
    const { k8s } = makeHaK8s(haCluster);
    expect((await instanceOn(k8s, makeDrainDb('fail'), 's1', 'system-db-1'))?.postgresInstance)
      .toMatchObject({ primary: true, coveredBy: [] });
  });

  it('a replica is not covered when the primary is not Ready', async () => {
    const { k8s } = makeHaK8s([
      { name: 'system-db-1', node: 's1', primary: true, ready: false },
      { name: 'system-db-2', node: 's2' },
      { name: 'system-db-3', node: 's3' },
    ]);
    expect((await instanceOn(k8s, makeDrainDb(), 's2', 'system-db-2'))?.postgresInstance?.coveredBy).toEqual([]);
  });

  it('a replica is not covered when the primary sits on a cordoned node — that node is going away too', async () => {
    const { k8s } = makeHaK8s(haCluster, { cordoned: ['s1'] });
    expect((await instanceOn(k8s, makeDrainDb(), 's2', 'system-db-2'))?.postgresInstance?.coveredBy).toEqual([]);
  });

  it('a replica is not covered when the primary runs on the draining node too', async () => {
    const { k8s } = makeHaK8s([
      { name: 'system-db-1', node: 's2', primary: true },
      { name: 'system-db-2', node: 's2' },
    ]);
    expect((await instanceOn(k8s, makeDrainDb(), 's2', 'system-db-2'))?.postgresInstance?.coveredBy).toEqual([]);
  });

  it('a replica is not covered when the primary runs elsewhere but its volume sits on the draining node', async () => {
    const { k8s } = makeHaK8s([
      { name: 'system-db-1', node: 's1', primary: true, replicaOn: 's2' },
      { name: 'system-db-2', node: 's2' },
    ]);
    expect((await instanceOn(k8s, makeDrainDb(), 's2', 'system-db-2'))?.postgresInstance?.coveredBy).toEqual([]);
  });

  it('fails closed: an unreadable CNPG list leaves the last replica with no instance facts', async () => {
    const { k8s } = makeHaK8s(haCluster, { cnpgListFails: true });
    expect(await instanceOn(k8s, makeDrainDb(), 's2', 'system-db-2'))
      .toMatchObject({ isLastReplica: true, postgresInstance: null });
  });

  it('drainNode: a covered instance does not block the drain — and its pod is not evicted', async () => {
    const { k8s, patchNode, evict } = makeHaK8s(haCluster);
    const result = await drainNode(k8s, makeDrainDb(), 's2', { tenantPlacement: {}, blockNewTenants: false });
    // A drain moves tenants only: no cordon — the one node patch is the mark.
    expect(result).toMatchObject({ cordoned: false, blockedNewTenants: false, evicted: 0, failed: [] });
    expect(patchNode).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(patchNode.mock.calls[0][0])).toContain('insula.host/tenants-drained');
    expect(JSON.stringify(patchNode.mock.calls[0][0])).not.toContain('unschedulable');
    expect(evict).not.toHaveBeenCalled();
  });

  // "Drain tenants" never cordons a server: it switches off "Can host tenant
  // workloads" (label + the server-only NoSchedule taint every system workload
  // tolerates). A chainable stub lets the real updateNode run against it.
  function chainDb(canHost: Record<string, boolean> = {}): Database {
    const rows = Object.assign(
      ['s1', 's2', 's3'].map((name) => ({
        name, role: 'server', canHostTenantWorkloads: canHost[name] ?? true, labels: {},
        taints: canHost[name] === false ? [{ key: 'insula.host/server-only', value: 'true', effect: 'NoSchedule' }] : [],
        ingressMode: 'all',
      })),
      { rows: [] as unknown[] },
    );
    const proxy: unknown = new Proxy(() => proxy, {
      get: (_t, prop) => (prop === 'then' ? (res: (v: unknown) => void) => res(rows) : () => proxy),
      apply: () => proxy,
    });
    return proxy as Database;
  }
  const tolerantLonghorn = (k8s: K8sClients, tolerations: unknown[] | undefined) => {
    (k8s as unknown as { apps: Record<string, unknown> }).apps = {
      ...((k8s as unknown as { apps?: Record<string, unknown> }).apps ?? {}),
      listNamespacedDaemonSet: vi.fn(async () => ({ items: [{ metadata: { name: 'longhorn-csi-plugin' }, spec: { template: { spec: { tolerations } } } }] })),
    };
    // Longhorn's taint-toleration setting, which its instance managers take.
    const custom = (k8s as unknown as { custom: Record<string, unknown> }).custom;
    custom.getNamespacedCustomObject = vi.fn(async () => ({ value: 'insula.host/server-only=true:NoSchedule' }));
  };

  it('drainNode on a server: new tenants are kept off by the taint — never a cordon — and the node is marked', async () => {
    const { k8s, patchNode } = makeHaK8s(haCluster);
    tolerantLonghorn(k8s, [{ key: 'insula.host/server-only', operator: 'Equal', value: 'true', effect: 'NoSchedule' }]);
    const result = await drainNode(k8s, chainDb(), 's2', { tenantPlacement: {} });
    expect(result).toMatchObject({ cordoned: false, blockedNewTenants: true });
    const bodies = patchNode.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(bodies.some((b) => b.includes('"insula.host/host-tenant-workloads":"false"') && b.includes('"key":"insula.host/server-only"'))).toBe(true);
    expect(bodies.some((b) => b.includes('insula.host/tenants-drained'))).toBe(true);
    expect(bodies.some((b) => b.includes('"unschedulable":true'))).toBe(false);
  });

  it('drainNode refuses — before changing anything — while Longhorn would not tolerate the taint', async () => {
    const { k8s, patchNode, evict } = makeHaK8s(haCluster);
    tolerantLonghorn(k8s, undefined);
    await expect(drainNode(k8s, chainDb(), 's2', { tenantPlacement: {} }))
      .rejects.toMatchObject({ code: 'NODE_TENANT_TAINT_UNSAFE', status: 409 });
    expect(patchNode).not.toHaveBeenCalled();
    expect(evict).not.toHaveBeenCalled();
  });

  it('drainNode refuses — before changing anything — a re-pin target that does not host tenants (a tenant-drained server)', async () => {
    const { k8s, patchNode, evict } = makeHaK8s(haCluster);
    tolerantLonghorn(k8s, [{ operator: 'Exists' }]);
    await expect(drainNode(k8s, chainDb({ s3: false }), 's2', { tenantPlacement: { 'tenant-a': 's3' } }))
      .rejects.toMatchObject({ code: 'NODE_REPIN_TARGET_UNAVAILABLE', status: 409, details: { target: 's3' } });
    expect(patchNode).not.toHaveBeenCalled();
    expect(evict).not.toHaveBeenCalled();
  });

  it('an edit-form save that leaves "Can host tenant workloads" as it was keeps the drained mark; turning it on clears it', async () => {
    const patchNode = vi.fn(async () => ({}));
    const k8s = { core: { patchNode, readNode: vi.fn(async () => { throw new Error('skip refresh'); }) } } as unknown as K8sClients;
    // A server drained with "keep new tenants off" unticked: still hosts tenants. Its notes are edited.
    await updateNode(chainDb({ s1: true }), k8s, 's1', { canHostTenantWorkloads: true, notes: 'rack 4' });
    expect(JSON.stringify(patchNode.mock.calls)).not.toContain('tenants-drained');
    // A tenant-drained server is let back.
    patchNode.mockClear();
    await updateNode(chainDb({ s1: false }), k8s, 's1', { canHostTenantWorkloads: true });
    expect(JSON.stringify(patchNode.mock.calls[0][0])).toContain('"insula.host/tenants-drained":null');
  });

  it('drainNode: an uncovered instance still blocks without forceLastReplica', async () => {
    const { k8s, patchNode } = makeHaK8s([
      { name: 'system-db-1', node: 's1', primary: true, ready: false },
      { name: 'system-db-2', node: 's2' },
    ]);
    await expect(drainNode(k8s, makeDrainDb(), 's2', { tenantPlacement: {}, blockNewTenants: false }))
      .rejects.toMatchObject({ code: 'NODE_DRAIN_BLOCKED_LAST_REPLICA', status: 409 });
    expect(patchNode).not.toHaveBeenCalled();
  });

  it('drainNode: the primary with no streaming standby still blocks', async () => {
    const { k8s } = makeHaK8s(haCluster);
    await expect(drainNode(k8s, makeDrainDb([]), 's1', { tenantPlacement: {}, blockNewTenants: false }))
      .rejects.toMatchObject({ code: 'NODE_DRAIN_BLOCKED_LAST_REPLICA', status: 409 });
  });

  it('a Released volume that still names an instance\'s claim is not that instance', async () => {
    // A CNPG scale-down deletes the claim; with the Retain policy the old
    // volume stays, Released, still naming `system-db-3`.
    const { k8s } = makeHaK8s(haCluster);
    const custom = k8s.custom as unknown as { listNamespacedCustomObject: ReturnType<typeof vi.fn> };
    const base = custom.listNamespacedCustomObject.getMockImplementation()!;
    custom.listNamespacedCustomObject.mockImplementation(async (req: { plural: string }) => {
      const res = await base(req) as { items: unknown[] };
      if (req.plural === 'volumes') {
        res.items.push({
          metadata: { name: 'pvc-old-db3' },
          status: { state: 'detached', kubernetesStatus: { pvcName: 'system-db-3', namespace: 'platform', pvStatus: 'Released' } },
        });
      }
      if (req.plural === 'replicas') {
        res.items.push({ metadata: { name: 'r-old-db3' }, spec: { volumeName: 'pvc-old-db3', nodeID: 's2', failedAt: '' }, status: { currentState: 'stopped' } });
      }
      return res;
    });
    const impact = await buildDrainImpact(k8s, makeDrainDb(), 's2');
    const orphan = impact.longhornReplicas.find((r) => r.volumeName === 'pvc-old-db3');
    expect(orphan).toMatchObject({ isLastReplica: true, postgresInstance: null });
    // The live system-db-3 runs on s3 — s2's own instance is the only one deleteNode would name.
    const live = impact.longhornReplicas.filter((r) => r.postgresInstance).map((r) => r.postgresInstance?.instance);
    expect(live).toEqual(['system-db-2']);
  });

  it('deleteNode: refuses while the node holds an instance\'s only copy — covered or not', async () => {
    const { k8s, deleteK8sNode } = makeHaK8s(haCluster, { targetCordoned: true, cordoned: ['s2'] });
    await expect(deleteNode(makeDrainDb(), k8s, 's2')).rejects.toMatchObject({
      code: 'NODE_DELETE_HOLDS_DATABASE',
      status: 409,
      details: { instances: ['platform/system-db-2'] },
    });
    expect(deleteK8sNode).not.toHaveBeenCalled();
  });
});

// ─── A tenant that runs nothing (stopped / suspended) ────────────────────
//
// Longhorn moves a replica only while its volume is attached. A re-pin of a
// tenant with nothing running changed every label and left the only copy on
// the drained node (production: suspended tenant pinned to sv1, its replica
// still on the cordoned sv2, the drain never complete).
describe('drain of a node holding a stopped tenant\'s only copy', () => {
  const NS = 'tenant-hat-1';
  const GiB = 1024 ** 3;

  function makeStoppedTenantK8s(opts: { attached?: boolean; cordoned?: string[] } = {}) {
    const patches: Array<{ plural: string; name: string; body: unknown }> = [];
    const cordoned = new Set(opts.cordoned ?? []);
    const lhNode = (name: string, freeGiB: number) => ({
      metadata: { name },
      spec: { allowScheduling: true, tags: [], disks: { d1: { allowScheduling: true, storageReserved: 0 } } },
      status: { diskStatus: { d1: { storageMaximum: (freeGiB + 10) * GiB, storageScheduled: 10 * GiB } } },
    });
    const k8s = {
      core: {
        readNode: vi.fn().mockResolvedValue({
          spec: { unschedulable: false }, status: { conditions: [{ type: 'Ready', status: 'True' }] },
        }),
        listNode: vi.fn().mockResolvedValue({
          items: ['s1', 's2', 's3'].map((name) => liveNode({ name, unschedulable: cordoned.has(name) })),
        }),
        listPodForAllNamespaces: vi.fn().mockResolvedValue({ items: [] }),
        listPersistentVolumeClaimForAllNamespaces: vi.fn().mockResolvedValue({ items: [] }),
        listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
        patchNode: vi.fn().mockResolvedValue({}),
        createNamespacedPodEviction: vi.fn().mockResolvedValue({}),
        deleteNode: vi.fn().mockResolvedValue({}),
      },
      apps: {
        listDeploymentForAllNamespaces: vi.fn().mockResolvedValue({
          items: [{
            metadata: { name: 'website', namespace: NS },
            spec: { replicas: 0, template: { spec: { nodeSelector: { 'kubernetes.io/hostname': 's2' } } } },
          }],
        }),
        listStatefulSetForAllNamespaces: vi.fn().mockResolvedValue({ items: [] }),
        readNamespacedDeployment: vi.fn().mockResolvedValue({ spec: { template: { spec: {} } } }),
        patchNamespacedDeployment: vi.fn().mockResolvedValue({}),
      },
      custom: {
        listNamespacedCustomObject: vi.fn(async (req: { plural: string }) => {
          if (req.plural === 'replicas') {
            return { items: [{ metadata: { name: 'r-hat' }, spec: { volumeName: 'pvc-hat', nodeID: 's2', failedAt: '' }, status: { currentState: opts.attached ? 'running' : 'stopped' } }] };
          }
          if (req.plural === 'volumes') {
            return {
              items: [{
                metadata: { name: 'pvc-hat' },
                spec: { size: String(20 * GiB), numberOfReplicas: 1, nodeSelector: ['node-s2'] },
                status: {
                  state: opts.attached ? 'attached' : 'detached',
                  currentNodeID: opts.attached ? 's2' : '',
                  kubernetesStatus: { namespace: NS, pvcName: `${NS}-storage`, pvStatus: 'Bound' },
                },
              }],
            };
          }
          if (req.plural === 'nodes') return { items: [lhNode('s1', 50), lhNode('s2', 200), lhNode('s3', 80)] };
          return { items: [] };
        }),
        getNamespacedCustomObject: vi.fn().mockResolvedValue({ spec: { tags: [] } }),
        patchNamespacedCustomObject: vi.fn(async (a: { plural: string; name: string; body: unknown }) => {
          patches.push({ plural: a.plural, name: a.name, body: a.body });
          return {};
        }),
      },
    } as unknown as K8sClients;
    return { k8s, patches };
  }

  function makeTenantDb(pin = 's2'): Database {
    const nodeRows = ['s1', 's2', 's3'].map((name) => ({ name, role: 'server', canHostTenantWorkloads: true }));
    const tenantRows = [{ id: 'hat-id', name: 'Hat Co', ns: NS, tier: 'local', pin }];
    return {
      select: () => ({
        from: (tbl: object) => {
          const rows = 'storageTier' in tbl ? tenantRows : nodeRows;
          return Object.assign(Promise.resolve(rows), { orderBy: () => Promise.resolve(nodeRows) });
        },
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as Database;
  }

  const tickets = (patches: Array<{ plural: string; name: string; body: unknown }>) => patches
    .filter((p) => p.plural === 'volumeattachments')
    .map((p) => ({
      volume: p.name,
      node: (p.body as { spec: { attachmentTickets: Record<string, { nodeID: string }> } }).spec.attachmentTickets['insula-relocate']?.nodeID,
    }));

  it('impact marks the stopped tenant\'s volume detached, its only copy here', async () => {
    const { k8s } = makeStoppedTenantK8s();
    const impact = await buildDrainImpact(k8s, makeTenantDb(), 's2');
    expect(impact.pinnedTenants[0]?.pvcs[0]).toMatchObject({ volumeName: 'pvc-hat', detached: true, isLastReplica: true, replicaCount: 1 });
  });

  it('"Auto" picks the node with the most free space — never this one — and moves the data there', async () => {
    const { k8s, patches } = makeStoppedTenantK8s();
    const result = await drainNode(k8s, makeTenantDb(), 's2', { tenantPlacement: {}, blockNewTenants: false });
    expect(result.pickedTargets).toEqual({ 'hat-id': 's3' });
    expect(result.relocatingVolumes).toBe(1);
    expect(tickets(patches)).toEqual([{ volume: 'pvc-hat', node: 's3' }]);
  });

  it('"Auto" never picks a cordoned node', async () => {
    const { k8s, patches } = makeStoppedTenantK8s({ cordoned: ['s3'] });
    const result = await drainNode(k8s, makeTenantDb(), 's2', { tenantPlacement: {}, blockNewTenants: false });
    expect(result.pickedTargets).toEqual({ 'hat-id': 's1' });
    expect(tickets(patches)).toEqual([{ volume: 'pvc-hat', node: 's1' }]);
  });

  it('an explicit target moves the data to that node', async () => {
    const { k8s, patches } = makeStoppedTenantK8s();
    const result = await drainNode(k8s, makeTenantDb(), 's2', { tenantPlacement: { 'hat-id': 's1' }, blockNewTenants: false });
    expect(result.pickedTargets).toEqual({});
    expect(result.relocatingVolumes).toBe(1);
    expect(tickets(patches)).toEqual([{ volume: 'pvc-hat', node: 's1' }]);
  });

  it('a running tenant on "Auto" is left to the scheduler — its data follows the pod', async () => {
    const { k8s, patches } = makeStoppedTenantK8s({ attached: true });
    const result = await drainNode(k8s, makeTenantDb(), 's2', { tenantPlacement: {}, blockNewTenants: false });
    expect(result.pickedTargets).toEqual({});
    expect(result.relocatingVolumes).toBe(0);
    expect(tickets(patches)).toEqual([]);
  });

  it('a re-run keeps the node an earlier run pinned the tenant to — the data still goes there', async () => {
    // Production: the suspended tenant was already pinned to sv1 with its copy on sv2.
    const { k8s, patches } = makeStoppedTenantK8s();
    const result = await drainNode(k8s, makeTenantDb('s3'), 's2', { tenantPlacement: {}, blockNewTenants: false });
    expect(result.pickedTargets).toEqual({});
    expect(result.relocatingVolumes).toBe(1);
    expect(tickets(patches)).toEqual([{ volume: 'pvc-hat', node: 's3' }]);
  });

  it('a copy that could not start moving is reported, not left looking slow', async () => {
    const { k8s } = makeStoppedTenantK8s();
    const custom = k8s.custom as unknown as { patchNamespacedCustomObject: ReturnType<typeof vi.fn> };
    custom.patchNamespacedCustomObject.mockImplementation(async (a: { plural: string }) => {
      if (a.plural === 'volumeattachments') throw new Error('admission webhook denied the request');
      return {};
    });
    const result = await drainNode(k8s, makeTenantDb(), 's2', { tenantPlacement: {}, blockNewTenants: false });
    expect(result.relocatingVolumes).toBe(0);
    expect(result.relocationProblems).toEqual([expect.objectContaining({
      tenantId: 'hat-id', volumeName: 'pvc-hat', reason: expect.stringContaining('admission webhook denied'),
    })]);
  });

  it('deleteNode fails closed when the storage lists cannot be read', async () => {
    const { k8s } = makeStoppedTenantK8s();
    (k8s.core as unknown as { readNode: ReturnType<typeof vi.fn> }).readNode.mockResolvedValue({ spec: { unschedulable: true } });
    const custom = k8s.custom as unknown as { listNamespacedCustomObject: ReturnType<typeof vi.fn> };
    custom.listNamespacedCustomObject.mockRejectedValue(Object.assign(new Error('etcdserver: request timed out'), { code: 500 }));
    await expect(deleteNode(makeTenantDb(), k8s, 's2'))
      .rejects.toMatchObject({ code: 'NODE_DELETE_PRECHECK_FAILED', status: 503 });
    expect((k8s.core as unknown as { deleteNode: ReturnType<typeof vi.fn> }).deleteNode).not.toHaveBeenCalled();
  });

  it('a tenant kept here ("stay") with its only copy here still blocks the drain without force', async () => {
    const { k8s } = makeStoppedTenantK8s();
    await expect(drainNode(k8s, makeTenantDb(), 's2', { tenantPlacement: { 'hat-id': 'stay' }, blockNewTenants: false }))
      .rejects.toMatchObject({ code: 'NODE_DRAIN_BLOCKED_LAST_REPLICA', status: 409 });
    await expect(drainNode(k8s, makeTenantDb(), 's2', { tenantPlacement: { 'hat-id': 'stay' }, forceLastReplica: true, blockNewTenants: false }))
      .resolves.toMatchObject({ cordoned: false });
  });

  it('a volume in a tenant namespace with no tenant record still blocks — nobody re-pins it', async () => {
    const { k8s } = makeStoppedTenantK8s();
    const db = makeTenantDb();
    const orphanDb = {
      ...db,
      select: () => ({
        from: (tbl: object) => {
          const nodeRows = ['s1', 's2', 's3'].map((name) => ({ name, role: 'server', canHostTenantWorkloads: true }));
          return Object.assign(Promise.resolve('storageTier' in tbl ? [] : nodeRows), { orderBy: () => Promise.resolve(nodeRows) });
        },
      }),
    } as unknown as Database;
    await expect(drainNode(k8s, orphanDb, 's2', { tenantPlacement: {}, blockNewTenants: false }))
      .rejects.toMatchObject({ code: 'NODE_DRAIN_BLOCKED_LAST_REPLICA', status: 409 });
  });

  it('deleteNode: refuses while a tenant volume\'s only copy is on the node', async () => {
    const { k8s } = makeStoppedTenantK8s();
    (k8s.core as unknown as { readNode: ReturnType<typeof vi.fn> }).readNode.mockResolvedValue({ spec: { unschedulable: true } });
    await expect(deleteNode(makeTenantDb(), k8s, 's2')).rejects.toMatchObject({
      code: 'NODE_DELETE_HOLDS_TENANT_DATA',
      status: 409,
      details: { volumes: [`Hat Co (${NS}/${NS}-storage)`] },
    });
    expect((k8s.core as unknown as { deleteNode: ReturnType<typeof vi.fn> }).deleteNode).not.toHaveBeenCalled();
  });
});

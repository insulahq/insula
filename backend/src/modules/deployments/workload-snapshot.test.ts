/**
 * The snapshot path exists purely to cut API request COUNT (see
 * workload-snapshot.ts). It is therefore only correct if it is
 * indistinguishable from the per-call path it replaces.
 *
 * So the central test here is an EQUIVALENCE matrix: one fixture cluster
 * drives two K8s mocks — one that answers namespaced reads the way the
 * apiserver does, one that serves the same objects through a snapshot — and
 * every scenario asserts the two produce byte-identical status.
 *
 * Asserting only "the snapshot path returns running" would pass just as well
 * if both paths were broken in the same direction, which is the failure mode
 * that matters when the point of the change is that nothing observable moves.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildWorkloadSnapshot,
  deploymentKey,
  podsForApp,
  type WorkloadSnapshot,
} from './workload-snapshot.js';
import { getDeploymentStatus } from './k8s-deployer.js';
import type { DeployComponentInput } from './k8s-deployer.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const NS = 'tenant-x';
const DEPLOY = 'my-apache-php';

const COMPONENTS: DeployComponentInput[] = [
  { name: 'apache-php', type: 'deployment', image: 'apache-php:1', ports: [], optional: false },
];

// ─── Fixture cluster ────────────────────────────────────────────────────────

interface FakePod {
  metadata: { name: string; namespace: string; labels?: Record<string, string>; deletionTimestamp?: string };
  spec?: { nodeName?: string };
  status?: Record<string, unknown>;
}
interface FakeDeploy {
  metadata: { name: string; namespace: string };
  spec: { replicas: number };
  status: { replicas: number; readyReplicas: number };
}
interface FakeCluster {
  deployments: FakeDeploy[];
  pods: FakePod[];
}

function deploy(name: string, ready: number, replicas = 1, namespace = NS): FakeDeploy {
  return { metadata: { name, namespace }, spec: { replicas }, status: { replicas, readyReplicas: ready } };
}

function livePod(app = DEPLOY, nodeName = 'node-live', namespace = NS): FakePod {
  return {
    metadata: { name: `${app}-6f474fdf79-gpzj4`, namespace, labels: { app } },
    spec: { nodeName },
    status: { phase: 'Running', containerStatuses: [{ name: 'apache-php', ready: true, state: { running: {} } }] },
  };
}

/** The node-reboot corpse from the production incident these paths must agree on. */
function shutdownCorpse(app = DEPLOY, nodeName = 'node-dead', namespace = NS): FakePod {
  return {
    metadata: { name: `${app}-6f474fdf79-nlztt`, namespace, labels: { app } },
    spec: { nodeName },
    status: {
      phase: 'Failed',
      reason: 'Terminated',
      message: 'Pod was terminated in response to imminent node shutdown.',
      containerStatuses: [{ name: 'apache-php', ready: false, state: { terminated: { exitCode: 137, reason: 'Error' } } }],
    },
  };
}

function crashLoopPod(app = DEPLOY, namespace = NS): FakePod {
  return {
    metadata: { name: `${app}-crash`, namespace, labels: { app } },
    status: {
      phase: 'Running',
      containerStatuses: [{
        name: 'apache-php',
        ready: false,
        state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s' } },
      }],
    },
  };
}

function oomPod(app = DEPLOY, namespace = NS): FakePod {
  return {
    metadata: { name: `${app}-oom`, namespace, labels: { app } },
    status: {
      phase: 'Running',
      containerStatuses: [{
        name: 'apache-php',
        ready: false,
        state: { terminated: { exitCode: 137, reason: 'OOMKilled', message: 'out of memory' } },
      }],
    },
  };
}

function unschedulablePod(app = DEPLOY, namespace = NS): FakePod {
  return {
    metadata: { name: `${app}-pending`, namespace, labels: { app } },
    status: {
      phase: 'Pending',
      conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'insufficient cpu' }],
    },
  };
}

// ─── Two mocks over one fixture ─────────────────────────────────────────────

/** Answers namespaced reads the way the apiserver does — the ORIGINAL path. */
function perCallK8s(cluster: FakeCluster): { k8s: K8sClients; calls: () => number } {
  let calls = 0;
  const k8s = {
    apps: {
      readNamespacedDeployment: vi.fn(async ({ name, namespace }: { name: string; namespace: string }) => {
        calls++;
        const d = cluster.deployments.find((x) => x.metadata.name === name && x.metadata.namespace === namespace);
        // The client surfaces a 404 as an Error carrying this marker; isK8s404 matches on it.
        if (!d) throw new Error('HTTP-Code: 404');
        return d;
      }),
      listDeploymentForAllNamespaces: vi.fn(async () => { calls++; return { items: cluster.deployments }; }),
    },
    core: {
      listNamespacedPod: vi.fn(async ({ namespace, labelSelector }: { namespace: string; labelSelector?: string }) => {
        calls++;
        const want = labelSelector?.startsWith('app=') ? labelSelector.slice(4) : undefined;
        return {
          items: cluster.pods.filter(
            (p) => p.metadata.namespace === namespace && (want === undefined || p.metadata.labels?.app === want),
          ),
        };
      }),
      listPodForAllNamespaces: vi.fn(async () => { calls++; return { items: cluster.pods }; }),
      listNamespacedEvent: vi.fn(async () => { calls++; return { items: [] }; }),
    },
  } as unknown as K8sClients;
  return { k8s, calls: () => calls };
}

async function snapshotOf(cluster: FakeCluster): Promise<WorkloadSnapshot> {
  return buildWorkloadSnapshot(perCallK8s(cluster).k8s);
}

// ─── buildWorkloadSnapshot / helpers ────────────────────────────────────────

describe('buildWorkloadSnapshot', () => {
  it('indexes deployments by namespace/name and groups pods by namespace', async () => {
    const snap = await snapshotOf({
      deployments: [deploy(DEPLOY, 1), deploy('other', 1, 1, 'tenant-y')],
      pods: [livePod(), livePod(DEPLOY, 'n', 'tenant-y')],
    });

    expect(snap.deployments.get(deploymentKey(NS, DEPLOY))).toBeDefined();
    expect(snap.deployments.get(deploymentKey('tenant-y', 'other'))).toBeDefined();
    expect(snap.deployments.get(deploymentKey('tenant-y', DEPLOY))).toBeUndefined();
    expect(snap.podsByNamespace.get(NS)).toHaveLength(1);
    expect(snap.podsByNamespace.get('tenant-y')).toHaveLength(1);
  });

  it('issues exactly two API requests regardless of how much is in the cluster', async () => {
    const many: FakeCluster = {
      deployments: Array.from({ length: 40 }, (_, i) => deploy(`d${i}`, 1)),
      pods: Array.from({ length: 200 }, (_, i) => livePod(`d${i % 40}`)),
    };
    const { k8s, calls } = perCallK8s(many);
    await buildWorkloadSnapshot(k8s);
    expect(calls()).toBe(2);
  });

  it('skips objects with no name or namespace rather than indexing an unreachable key', async () => {
    const k8s = {
      apps: { listDeploymentForAllNamespaces: vi.fn(async () => ({ items: [{ metadata: { name: 'x' } }, { metadata: {} }] })) },
      core: { listPodForAllNamespaces: vi.fn(async () => ({ items: [{ metadata: {} }] })) },
    } as unknown as K8sClients;
    const snap = await buildWorkloadSnapshot(k8s);
    expect(snap.deployments.size).toBe(0);
    expect(snap.podsByNamespace.size).toBe(0);
  });

  it('tolerates a list response with no items array', async () => {
    const k8s = {
      apps: { listDeploymentForAllNamespaces: vi.fn(async () => ({})) },
      core: { listPodForAllNamespaces: vi.fn(async () => ({})) },
    } as unknown as K8sClients;
    const snap = await buildWorkloadSnapshot(k8s);
    expect(snap.deployments.size).toBe(0);
    expect(snap.podsByNamespace.size).toBe(0);
  });
});

describe('podsForApp', () => {
  it('matches the app label exactly, like labelSelector app=<name> does', async () => {
    const snap = await snapshotOf({
      deployments: [],
      // `my-apache-php-db` must NOT match `my-apache-php` — a prefix match here
      // would fold a sibling component's pods into the wrong status.
      pods: [livePod(DEPLOY), livePod(`${DEPLOY}-db`), livePod('unrelated')],
    });
    const got = podsForApp(snap, NS, DEPLOY);
    expect(got).toHaveLength(1);
    expect(got[0].metadata?.labels?.app).toBe(DEPLOY);
  });

  it('returns empty for a namespace holding no pods', async () => {
    const snap = await snapshotOf({ deployments: [], pods: [] });
    expect(podsForApp(snap, 'tenant-nothing', DEPLOY)).toEqual([]);
  });

  it('ignores pods carrying no labels at all', async () => {
    const snap = await snapshotOf({
      deployments: [],
      pods: [{ metadata: { name: 'bare', namespace: NS } }],
    });
    expect(podsForApp(snap, NS, DEPLOY)).toEqual([]);
  });
});

// ─── The equivalence matrix ─────────────────────────────────────────────────

const SCENARIOS: Array<{ name: string; cluster: FakeCluster }> = [
  {
    name: 'healthy 1/1',
    cluster: { deployments: [deploy(DEPLOY, 1)], pods: [livePod()] },
  },
  {
    name: 'healthy beside a node-reboot corpse (the production false-OOM case)',
    cluster: { deployments: [deploy(DEPLOY, 1)], pods: [livePod(), shutdownCorpse()] },
  },
  {
    name: 'corpse listed FIRST — host node must come from the live pod',
    cluster: { deployments: [deploy(DEPLOY, 1)], pods: [shutdownCorpse('my-apache-php', 'node-dead'), livePod()] },
  },
  {
    name: 'deployment absent (404 / not in the list)',
    cluster: { deployments: [], pods: [] },
  },
  {
    name: 'scaled to zero',
    cluster: { deployments: [deploy(DEPLOY, 0, 0)], pods: [] },
  },
  {
    name: 'crash-looping',
    cluster: { deployments: [deploy(DEPLOY, 0)], pods: [crashLoopPod()] },
  },
  {
    name: 'OOM-killed',
    cluster: { deployments: [deploy(DEPLOY, 0)], pods: [oomPod()] },
  },
  {
    name: 'pending / unschedulable',
    cluster: { deployments: [deploy(DEPLOY, 0)], pods: [unschedulablePod()] },
  },
  {
    name: 'not ready with no pods at all',
    cluster: { deployments: [deploy(DEPLOY, 0, 2)], pods: [] },
  },
  {
    name: 'another tenant holds a same-named workload',
    cluster: {
      deployments: [deploy(DEPLOY, 1), deploy(DEPLOY, 0, 1, 'tenant-other')],
      pods: [livePod(), crashLoopPod(DEPLOY, 'tenant-other')],
    },
  },
  {
    // A sibling component in the SAME namespace whose app label extends this
    // one's. Without an exact label match the db pod folds into the web
    // component's status and a healthy deployment reports crash-looping.
    name: 'sibling component with a name-prefixed app label',
    cluster: {
      deployments: [deploy(DEPLOY, 1)],
      pods: [livePod(), crashLoopPod(`${DEPLOY}-db`)],
    },
  },
];

describe('snapshot path is equivalent to the per-call path', () => {
  for (const { name, cluster } of SCENARIOS) {
    it(name, async () => {
      const viaApi = await getDeploymentStatus(perCallK8s(cluster).k8s, NS, DEPLOY, COMPONENTS);
      const snap = await snapshotOf(cluster);
      const viaSnapshot = await getDeploymentStatus(perCallK8s(cluster).k8s, NS, DEPLOY, COMPONENTS, snap);
      expect(viaSnapshot).toEqual(viaApi);
    });
  }

  it('reads nothing from the API when a snapshot is supplied and the workload is healthy', async () => {
    const cluster: FakeCluster = { deployments: [deploy(DEPLOY, 1)], pods: [livePod()] };
    const snap = await snapshotOf(cluster);
    const { k8s, calls } = perCallK8s(cluster);
    await getDeploymentStatus(k8s, NS, DEPLOY, COMPONENTS, snap);
    expect(calls()).toBe(0);
  });

  it('still falls back to per-call reads when no snapshot is supplied', async () => {
    const cluster: FakeCluster = { deployments: [deploy(DEPLOY, 1)], pods: [livePod()] };
    const { k8s, calls } = perCallK8s(cluster);
    await getDeploymentStatus(k8s, NS, DEPLOY, COMPONENTS);
    // one readNamespacedDeployment + one listNamespacedPod
    expect(calls()).toBe(2);
  });
});

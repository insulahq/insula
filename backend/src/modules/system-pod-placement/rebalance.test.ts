import { describe, it, expect } from 'vitest';
import {
  planRebalance,
  type RawDeployment,
  type RawNode,
  type RawPod,
  type RawStatefulSet,
} from './rebalance.js';

type Spread = Array<{ maxSkew: number; topologyKey: string; whenUnsatisfiable: string; labelSelector?: { matchLabels: Record<string, string> } }>;

const hardSpread = (workload: string): Spread => [
  { maxSkew: 1, topologyKey: 'kubernetes.io/hostname', whenUnsatisfiable: 'DoNotSchedule', labelSelector: { matchLabels: { app: workload } } },
];

function node(name: string, opts: {
  role?: 'server' | 'worker';
  ready?: boolean;
  unschedulable?: boolean;
  taints?: Array<{ key: string; value?: string; effect: string }>;
  cpu?: string;
  memory?: string;
  pods?: string;
} = {}): RawNode {
  return {
    metadata: { name, labels: { 'kubernetes.io/hostname': name, 'insula.host/node-role': opts.role ?? 'server' } },
    spec: { unschedulable: opts.unschedulable, taints: opts.taints },
    status: {
      allocatable: { cpu: opts.cpu ?? '4', memory: opts.memory ?? '8Gi', pods: opts.pods ?? '110' },
      conditions: [{ type: 'Ready', status: opts.ready === false ? 'False' : 'True' }],
    },
  };
}

function deployment(ns: string, name: string, replicas: number, over: Partial<NonNullable<RawDeployment['status']>> = {}): RawDeployment {
  return {
    metadata: { namespace: ns, name, generation: 3 },
    spec: { replicas },
    status: {
      observedGeneration: 3, replicas, updatedReplicas: replicas, readyReplicas: replicas, availableReplicas: replicas,
      ...over,
    },
  };
}

let seq = 0;
function pod(ns: string, workload: string, nodeName: string, opts: {
  hash?: string;
  created?: string;
  spread?: Spread;
  hostPort?: number;
  ephemeral?: boolean;
  limitsOnly?: boolean;
  antiAffinity?: boolean;
  nodeSelector?: Record<string, string>;
  tolerations?: Array<{ key?: string; operator?: string; value?: string; effect?: string }>;
  pvc?: boolean;
  ready?: boolean;
  phase?: string;
  cpu?: string;
  memory?: string;
  statefulSet?: boolean;
} = {}): RawPod {
  seq += 1;
  const hash = opts.hash ?? '6d4b8c9f7';
  return {
    metadata: {
      namespace: ns,
      name: `${workload}-${seq}`,
      creationTimestamp: opts.created ?? `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`,
      labels: opts.statefulSet ? { app: workload } : { app: workload, 'pod-template-hash': hash },
      ownerReferences: [opts.statefulSet
        ? { kind: 'StatefulSet', name: workload, controller: true }
        : { kind: 'ReplicaSet', name: `${workload}-${hash}`, controller: true }],
    },
    spec: {
      nodeName,
      nodeSelector: opts.nodeSelector,
      tolerations: opts.tolerations,
      topologySpreadConstraints: opts.antiAffinity ? undefined : (opts.spread ?? hardSpread(workload)),
      affinity: opts.antiAffinity
        ? { podAntiAffinity: { requiredDuringSchedulingIgnoredDuringExecution: [
          { topologyKey: 'kubernetes.io/hostname', labelSelector: { matchLabels: { app: workload } } },
        ] } }
        : undefined,
      containers: [{
        resources: opts.limitsOnly
          ? { limits: { cpu: opts.cpu ?? '10m', memory: opts.memory ?? '32Mi' } }
          : { requests: { cpu: opts.cpu ?? '10m', memory: opts.memory ?? '32Mi' } },
        ports: opts.hostPort ? [{ hostPort: opts.hostPort }] : undefined,
      }],
      volumes: opts.pvc
        ? [{ persistentVolumeClaim: { claimName: 'data' } }]
        : opts.ephemeral ? [{ ephemeral: { volumeClaimTemplate: {} } }] : [{}],
    },
    status: {
      phase: opts.phase ?? 'Running',
      conditions: [{ type: 'Ready', status: opts.ready === false ? 'False' : 'True' }],
    },
  };
}

const servers = [node('s1'), node('s2'), node('s3')];

describe('planRebalance', () => {
  it('moves one of two replicas that started on the only server of a fresh install', () => {
    const a = pod('crowdsec', 'crowdsec', 's1', { created: '2026-01-01T00:00:00Z' });
    const b = pod('crowdsec', 'crowdsec', 's1', { created: '2026-01-01T00:05:00Z' });
    const plan = planRebalance({
      nodes: servers,
      pods: [a, b],
      deployments: [deployment('crowdsec', 'crowdsec', 2)],
      statefulSets: [],
    });
    expect(plan).toEqual([{
      key: 'crowdsec/crowdsec', namespace: 'crowdsec', pod: b.metadata!.name, workload: 'Deployment/crowdsec', fromNode: 's1', roomOn: 's2',
    }]);
  });

  it('moves one replica per workload per pass even when three share a node', () => {
    const pods = ['s1', 's1', 's1'].map((n) => pod('longhorn-system', 'longhorn-global-manager', n));
    const plan = planRebalance({
      nodes: servers, pods, deployments: [deployment('longhorn-system', 'longhorn-global-manager', 3)], statefulSets: [],
    });
    expect(plan).toHaveLength(1);
    expect(plan[0]!.fromNode).toBe('s1');
  });

  it('leaves replicas that are already one per node alone', () => {
    const plan = planRebalance({
      nodes: servers,
      pods: [pod('traefik', 'modsec-crs', 's1'), pod('traefik', 'modsec-crs', 's2')],
      deployments: [deployment('traefik', 'modsec-crs', 2)],
      statefulSets: [],
    });
    expect(plan).toEqual([]);
  });

  it('does nothing on a single server — there is nowhere to go', () => {
    const plan = planRebalance({
      nodes: [node('s1')],
      pods: [pod('traefik', 'modsec-crs', 's1'), pod('traefik', 'modsec-crs', 's1')],
      deployments: [deployment('traefik', 'modsec-crs', 2)],
      statefulSets: [],
    });
    expect(plan).toEqual([]);
  });

  it('does not move a replica whose workload has only a soft rule (it could land back on the same node)', () => {
    const soft = [{ maxSkew: 1, topologyKey: 'kubernetes.io/hostname', whenUnsatisfiable: 'ScheduleAnyway' }];
    const plan = planRebalance({
      nodes: servers,
      pods: [pod('crowdsec', 'crowdsec', 's1', { spread: soft }), pod('crowdsec', 'crowdsec', 's1', { spread: soft })],
      deployments: [deployment('crowdsec', 'crowdsec', 2)],
      statefulSets: [],
    });
    expect(plan).toEqual([]);
  });

  it('counts required pod anti-affinity on the hostname as a hard rule', () => {
    const plan = planRebalance({
      nodes: servers,
      pods: [pod('platform', 'dex', 's2', { antiAffinity: true }), pod('platform', 'dex', 's2', { antiAffinity: true })],
      deployments: [deployment('platform', 'dex', 2)],
      statefulSets: [],
    });
    expect(plan).toHaveLength(1);
    expect(plan[0]!.roomOn).toBe('s1');
  });

  it('waits while the workload is mid-rollout or a replica is not Ready', () => {
    const pods = [pod('platform-system', 'tenant-errors', 's1'), pod('platform-system', 'tenant-errors', 's1')];
    for (const status of [{ updatedReplicas: 1 }, { readyReplicas: 1 }, { observedGeneration: 2 }, { replicas: 3 }]) {
      expect(planRebalance({
        nodes: servers, pods, deployments: [deployment('platform-system', 'tenant-errors', 2, status)], statefulSets: [],
      })).toEqual([]);
    }
    const notReady = [pod('platform-system', 'tenant-errors', 's1'), pod('platform-system', 'tenant-errors', 's1', { ready: false })];
    expect(planRebalance({
      nodes: servers, pods: notReady, deployments: [deployment('platform-system', 'tenant-errors', 2)], statefulSets: [],
    })).toEqual([]);
  });

  it('never moves a pod that mounts a volume claim', () => {
    const plan = planRebalance({
      nodes: servers,
      pods: [pod('platform', 'api', 's1', { pvc: true }), pod('platform', 'api', 's1', { pvc: true })],
      deployments: [deployment('platform', 'api', 2)],
      statefulSets: [],
    });
    expect(plan).toEqual([]);
  });

  it('needs a Ready, schedulable node — a cordoned or down server is no room', () => {
    const pods = [pod('traefik', 'modsec-crs', 's1'), pod('traefik', 'modsec-crs', 's1')];
    const deployments = [deployment('traefik', 'modsec-crs', 2)];
    expect(planRebalance({
      nodes: [node('s1'), node('s2', { unschedulable: true }), node('s3', { ready: false })], pods, deployments, statefulSets: [],
    })).toEqual([]);
  });

  it('honours the pod nodeSelector and the node taints', () => {
    const onServers = { nodeSelector: { 'insula.host/node-role': 'server' } };
    const pods = [pod('platform', 'platform-api', 's1', onServers), pod('platform', 'platform-api', 's1', onServers)];
    const deployments = [deployment('platform', 'platform-api', 2)];
    // Only a worker is free: the pod may not go there.
    expect(planRebalance({
      nodes: [node('s1'), node('w1', { role: 'worker' })], pods, deployments, statefulSets: [],
    })).toEqual([]);

    const taint = { key: 'insula.host/server-only', value: 'true', effect: 'NoSchedule' };
    expect(planRebalance({
      nodes: [node('s1'), node('s2', { taints: [taint] })], pods, deployments, statefulSets: [],
    })).toEqual([]);

    const tolerant = { ...onServers, tolerations: [{ key: 'insula.host/server-only', operator: 'Exists', effect: 'NoSchedule' }] };
    const plan = planRebalance({
      nodes: [node('s1'), node('s2', { taints: [taint] })],
      pods: [pod('platform', 'platform-api', 's1', tolerant), pod('platform', 'platform-api', 's1', tolerant)],
      deployments,
      statefulSets: [],
    });
    expect(plan.map((p) => p.roomOn)).toEqual(['s2']);
  });

  it('needs the replica to fit: requests already on the free node count, tenants included', () => {
    const pods = [
      pod('traefik', 'modsec-crs', 's1', { memory: '512Mi' }),
      pod('traefik', 'modsec-crs', 's1', { memory: '512Mi' }),
      pod('tenant-acme', 'web', 's2', { memory: '7800Mi' }),
    ];
    expect(planRebalance({
      nodes: [node('s1'), node('s2')], pods, deployments: [deployment('traefik', 'modsec-crs', 2)], statefulSets: [],
    })).toEqual([]);
  });

  it('never touches a namespace outside the platform list', () => {
    const plan = planRebalance({
      nodes: servers,
      pods: [pod('tenant-acme', 'web', 's1'), pod('tenant-acme', 'web', 's1')],
      deployments: [deployment('tenant-acme', 'web', 2)],
      statefulSets: [],
    });
    expect(plan).toEqual([]);
  });

  it('moves a StatefulSet replica once its revision has settled', () => {
    const sts = (over: Partial<NonNullable<RawStatefulSet['status']>> = {}): RawStatefulSet => ({
      metadata: { namespace: 'redis-system', name: 'valkey', generation: 1 },
      spec: { replicas: 3 },
      status: { observedGeneration: 1, replicas: 3, readyReplicas: 3, currentRevision: 'valkey-1', updateRevision: 'valkey-1', ...over },
    });
    const pods = [
      pod('redis-system', 'valkey', 's1', { statefulSet: true }),
      pod('redis-system', 'valkey', 's1', { statefulSet: true }),
      pod('redis-system', 'valkey', 's2', { statefulSet: true }),
    ];
    expect(planRebalance({ nodes: servers, pods, deployments: [], statefulSets: [sts()] }))
      .toEqual([expect.objectContaining({ workload: 'StatefulSet/valkey', fromNode: 's1', roomOn: 's3' })]);
    expect(planRebalance({ nodes: servers, pods, deployments: [], statefulSets: [sts({ updateRevision: 'valkey-2' })] }))
      .toEqual([]);
  });

  it('needs the hard rule to count the workload\'s own pods', () => {
    const other: Spread = [{ maxSkew: 1, topologyKey: 'kubernetes.io/hostname', whenUnsatisfiable: 'DoNotSchedule', labelSelector: { matchLabels: { app: 'something-else' } } }];
    const unscoped: Spread = [{ maxSkew: 1, topologyKey: 'kubernetes.io/hostname', whenUnsatisfiable: 'DoNotSchedule' }];
    for (const spread of [other, unscoped]) {
      expect(planRebalance({
        nodes: servers,
        pods: [pod('traefik', 'modsec-crs', 's1', { spread }), pod('traefik', 'modsec-crs', 's1', { spread })],
        deployments: [deployment('traefik', 'modsec-crs', 2)],
        statefulSets: [],
      })).toEqual([]);
    }
  });

  it('leaves pods alone whose placement it cannot model', () => {
    const zone: Spread = [
      ...hardSpread('modsec-crs'),
      { maxSkew: 1, topologyKey: 'topology.kubernetes.io/zone', whenUnsatisfiable: 'DoNotSchedule', labelSelector: { matchLabels: { app: 'modsec-crs' } } },
    ];
    const cases: Array<Parameters<typeof pod>[3]> = [{ hostPort: 8443 }, { ephemeral: true }, { spread: zone }];
    for (const opts of cases) {
      expect(planRebalance({
        nodes: servers,
        pods: [pod('traefik', 'modsec-crs', 's1', opts), pod('traefik', 'modsec-crs', 's1', opts)],
        deployments: [deployment('traefik', 'modsec-crs', 2)],
        statefulSets: [],
      })).toEqual([]);
    }
  });

  it('counts a limits-only container at its limit when sizing the free node', () => {
    const pods = [
      pod('traefik', 'modsec-crs', 's1', { memory: '512Mi', limitsOnly: true }),
      pod('traefik', 'modsec-crs', 's1', { memory: '512Mi', limitsOnly: true }),
      pod('tenant-acme', 'web', 's2', { memory: '7800Mi', limitsOnly: true }),
    ];
    expect(planRebalance({
      nodes: [node('s1'), node('s2')], pods, deployments: [deployment('traefik', 'modsec-crs', 2)], statefulSets: [],
    })).toEqual([]);
  });

  it('leaves a workload it moved recently alone', () => {
    const input = {
      nodes: servers,
      pods: [pod('crowdsec', 'crowdsec', 's1'), pod('crowdsec', 'crowdsec', 's1')],
      deployments: [deployment('crowdsec', 'crowdsec', 2)],
      statefulSets: [],
    };
    expect(planRebalance(input)).toHaveLength(1);
    expect(planRebalance({ ...input, coolingDown: new Set(['crowdsec/crowdsec']) })).toEqual([]);
  });

  it('ignores a ReplicaSet that is not the Deployment it claims to be', () => {
    const stray = pod('platform', 'admin-panel', 's1', { hash: 'abc' });
    const p2 = pod('platform', 'admin-panel', 's1', { hash: 'abc' });
    const renamed = (p: RawPod): RawPod => ({
      ...p,
      metadata: { ...p.metadata, ownerReferences: [{ kind: 'ReplicaSet', name: 'other-xyz', controller: true }] },
    });
    expect(planRebalance({
      nodes: servers, pods: [renamed(stray), renamed(p2)], deployments: [deployment('platform', 'admin-panel', 2)], statefulSets: [],
    })).toEqual([]);
  });
});

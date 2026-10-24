import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { parseK8sQuantity } from '../../shared/k8s-quantity.js';

/**
 * One replica per server: move a replica that shares a node with another
 * replica of the same workload onto a node that holds none.
 *
 * The scheduler places a pod once and never moves it. A hard one-per-node rule
 * (topology spread DoNotSchedule, or required anti-affinity, on the hostname)
 * only binds pods being scheduled, so replicas that started while one server
 * was up — a fresh install, the first server back after a full-cluster
 * restart, a server deleted and joined again — stay doubled up after the
 * others come back. This pass finds those and evicts one of the doubled-up
 * pods; the workload's own rule then puts the replacement on a node that has
 * none.
 *
 * What it will NOT do, each because the move could leave a replica down:
 *   - touch a workload that is mid-rollout or not fully Ready;
 *   - touch a workload without a hard per-node rule that selects its own pods
 *     (its replacement could land right back on the same node);
 *   - move a pod that mounts a PersistentVolumeClaim or a generic ephemeral
 *     volume (a node-local volume would hold the replacement on the old node,
 *     where the rule now refuses it);
 *   - move a pod whose placement it cannot model: host ports or the host
 *     network, required pod affinity, required anti-affinity or a hard spread
 *     on any key other than the hostname;
 *   - move a pod unless a Ready, schedulable node it tolerates and fits on
 *     (selector, required node affinity, taints, CPU/memory/pod count) holds
 *     no replica of that workload;
 *   - move the same workload again within REBALANCE_COOLDOWN_MS.
 * One eviction per workload per pass, through the Eviction API, so a
 * PodDisruptionBudget can still say no. Tenant namespaces are never touched —
 * the namespaces it acts on are an explicit list.
 */

/** Platform namespaces whose multi-replica workloads are kept one per node. */
export const REBALANCE_NAMESPACES: readonly string[] = Object.freeze([
  'calico-system',
  'cert-manager',
  'cnpg-system',
  'crowdsec',
  'flux-system',
  'kube-system',
  'longhorn-system',
  'mail',
  'monitoring',
  'platform',
  'platform-system',
  'redis-system',
  'traefik',
]);

const HOSTNAME_KEY = 'kubernetes.io/hostname';

interface Toleration {
  readonly key?: string;
  readonly operator?: string;
  readonly value?: string;
  readonly effect?: string;
}

interface Taint {
  readonly key: string;
  readonly value?: string;
  readonly effect: string;
}

interface NodeSelectorRequirement {
  readonly key: string;
  readonly operator: string;
  readonly values?: readonly string[];
}

interface NodeSelectorTerm {
  readonly matchExpressions?: readonly NodeSelectorRequirement[];
  readonly matchFields?: readonly NodeSelectorRequirement[];
}

interface RawContainer {
  readonly resources?: { readonly requests?: Record<string, string>; readonly limits?: Record<string, string> };
  readonly ports?: ReadonlyArray<{ readonly hostPort?: number }>;
}

interface LabelSelector {
  readonly matchLabels?: Record<string, string>;
  readonly matchExpressions?: readonly NodeSelectorRequirement[];
}

interface PodAffinityTerm {
  readonly topologyKey?: string;
  readonly labelSelector?: LabelSelector;
}

export interface RawPod {
  readonly metadata?: {
    readonly name?: string;
    readonly namespace?: string;
    readonly creationTimestamp?: string | Date;
    readonly deletionTimestamp?: string | Date;
    readonly labels?: Record<string, string>;
    readonly ownerReferences?: ReadonlyArray<{ readonly kind?: string; readonly name?: string; readonly controller?: boolean }>;
  };
  readonly spec?: {
    readonly nodeName?: string;
    readonly nodeSelector?: Record<string, string>;
    readonly tolerations?: readonly Toleration[];
    readonly hostNetwork?: boolean;
    readonly containers?: readonly RawContainer[];
    readonly initContainers?: readonly RawContainer[];
    readonly overhead?: Record<string, string>;
    readonly volumes?: ReadonlyArray<{ readonly persistentVolumeClaim?: unknown; readonly ephemeral?: unknown }>;
    readonly topologySpreadConstraints?: ReadonlyArray<{
      readonly maxSkew?: number;
      readonly topologyKey?: string;
      readonly whenUnsatisfiable?: string;
      readonly labelSelector?: LabelSelector;
    }>;
    readonly affinity?: {
      readonly nodeAffinity?: {
        readonly requiredDuringSchedulingIgnoredDuringExecution?: { readonly nodeSelectorTerms?: readonly NodeSelectorTerm[] };
      };
      readonly podAffinity?: {
        readonly requiredDuringSchedulingIgnoredDuringExecution?: readonly PodAffinityTerm[];
      };
      readonly podAntiAffinity?: {
        readonly requiredDuringSchedulingIgnoredDuringExecution?: readonly PodAffinityTerm[];
      };
    };
  };
  readonly status?: {
    readonly phase?: string;
    readonly conditions?: ReadonlyArray<{ readonly type?: string; readonly status?: string }>;
  };
}

export interface RawNode {
  readonly metadata?: {
    readonly name?: string;
    readonly labels?: Record<string, string>;
    readonly deletionTimestamp?: string | Date;
  };
  readonly spec?: { readonly unschedulable?: boolean; readonly taints?: readonly Taint[] };
  readonly status?: {
    readonly allocatable?: Record<string, string>;
    readonly conditions?: ReadonlyArray<{ readonly type?: string; readonly status?: string }>;
  };
}

interface RawWorkloadMeta {
  readonly name?: string;
  readonly namespace?: string;
  readonly generation?: number;
}

export interface RawDeployment {
  readonly metadata?: RawWorkloadMeta;
  readonly spec?: { readonly replicas?: number };
  readonly status?: {
    readonly observedGeneration?: number;
    readonly replicas?: number;
    readonly updatedReplicas?: number;
    readonly readyReplicas?: number;
    readonly availableReplicas?: number;
  };
}

export interface RawStatefulSet {
  readonly metadata?: RawWorkloadMeta;
  readonly spec?: { readonly replicas?: number };
  readonly status?: {
    readonly observedGeneration?: number;
    readonly replicas?: number;
    readonly readyReplicas?: number;
    readonly currentRevision?: string;
    readonly updateRevision?: string;
  };
}

export interface PlannedEviction {
  /** `<ns>/<workload name>`. */
  readonly key: string;
  readonly namespace: string;
  readonly pod: string;
  /** `Deployment/<name>` or `StatefulSet/<name>`. */
  readonly workload: string;
  readonly fromNode: string;
  /** A node the replacement can go to — the scheduler picks among such nodes. */
  readonly roomOn: string;
}

export interface RebalanceInput {
  /** Workloads (`<ns>/<name>`) moved recently — left alone this pass. */
  readonly coolingDown?: ReadonlySet<string>;
  readonly nodes: readonly RawNode[];
  /** Every non-terminated pod in the cluster — target-node capacity counts tenants' pods too. */
  readonly pods: readonly RawPod[];
  readonly deployments: readonly RawDeployment[];
  readonly statefulSets: readonly RawStatefulSet[];
  readonly namespaces?: readonly string[];
}

function isTrue(conditions: ReadonlyArray<{ readonly type?: string; readonly status?: string }> | undefined, type: string): boolean {
  return (conditions ?? []).some((c) => c.type === type && c.status === 'True');
}

/** Does the selector pick this pod — i.e. does the rule count the workload's own replicas? */
function selectsOwnPod(selector: LabelSelector | undefined, pod: RawPod): boolean {
  if (!selector) return false;
  const labels = pod.metadata?.labels ?? {};
  const ml = Object.entries(selector.matchLabels ?? {});
  const me = selector.matchExpressions ?? [];
  if (ml.length === 0 && me.length === 0) return false; // selects everything: not a per-workload rule
  return ml.every(([k, v]) => labels[k] === v)
    && me.every((r) => r.operator !== 'Gt' && r.operator !== 'Lt' && requirementHolds(r, labels[r.key]));
}

function hasHardPerNodeRule(pod: RawPod): boolean {
  const spread = pod.spec?.topologySpreadConstraints ?? [];
  if (spread.some((c) => c.topologyKey === HOSTNAME_KEY && c.whenUnsatisfiable === 'DoNotSchedule'
      && c.maxSkew === 1 && selectsOwnPod(c.labelSelector, pod))) {
    return true;
  }
  const anti = pod.spec?.affinity?.podAntiAffinity?.requiredDuringSchedulingIgnoredDuringExecution ?? [];
  return anti.some((t) => t.topologyKey === HOSTNAME_KEY && selectsOwnPod(t.labelSelector, pod));
}

/** Placement this pass does not model — a "room" verdict could be wrong. */
function hasUnmodelledPlacement(pod: RawPod): boolean {
  const spec = pod.spec ?? {};
  if (spec.hostNetwork === true) return true;
  if ([...(spec.containers ?? []), ...(spec.initContainers ?? [])].some((c) => (c.ports ?? []).some((p) => (p.hostPort ?? 0) > 0))) {
    return true;
  }
  if ((spec.affinity?.podAffinity?.requiredDuringSchedulingIgnoredDuringExecution ?? []).length > 0) return true;
  if ((spec.affinity?.podAntiAffinity?.requiredDuringSchedulingIgnoredDuringExecution ?? []).some((t) => t.topologyKey !== HOSTNAME_KEY)) {
    return true;
  }
  return (spec.topologySpreadConstraints ?? []).some((c) => c.whenUnsatisfiable === 'DoNotSchedule' && c.topologyKey !== HOSTNAME_KEY);
}

function mountsClaim(pod: RawPod): boolean {
  return (pod.spec?.volumes ?? []).some((v) =>
    (v.persistentVolumeClaim !== undefined && v.persistentVolumeClaim !== null)
    || (v.ephemeral !== undefined && v.ephemeral !== null));
}

function tolerates(tolerations: readonly Toleration[], taint: Taint): boolean {
  return tolerations.some((t) => {
    if (t.effect && t.effect !== taint.effect) return false;
    if (t.operator === 'Exists') return !t.key || t.key === taint.key;
    return t.key === taint.key && (t.value ?? '') === (taint.value ?? '');
  });
}

function requirementHolds(req: NodeSelectorRequirement, actual: string | undefined): boolean {
  const values = req.values ?? [];
  switch (req.operator) {
    case 'In': return actual !== undefined && values.includes(actual);
    case 'NotIn': return actual === undefined || !values.includes(actual);
    case 'Exists': return actual !== undefined;
    case 'DoesNotExist': return actual === undefined;
    case 'Gt':
    case 'Lt': {
      const a = Number(actual);
      const b = Number(values[0]);
      if (actual === undefined || !Number.isInteger(a) || !Number.isInteger(b)) return false;
      return req.operator === 'Gt' ? a > b : a < b;
    }
    // Unknown operator: say "does not fit" — a wrong yes could strand a replica.
    default: return false;
  }
}

function termHolds(term: NodeSelectorTerm, node: RawNode): boolean {
  const labels = node.metadata?.labels ?? {};
  const exprs = term.matchExpressions ?? [];
  const fields = term.matchFields ?? [];
  if (exprs.length === 0 && fields.length === 0) return false; // an empty term matches nothing
  return exprs.every((r) => requirementHolds(r, labels[r.key]))
    && fields.every((r) => r.key === 'metadata.name' && requirementHolds(r, node.metadata?.name));
}

function podSelectsNode(pod: RawPod, node: RawNode): boolean {
  const labels = node.metadata?.labels ?? {};
  for (const [k, v] of Object.entries(pod.spec?.nodeSelector ?? {})) {
    if (labels[k] !== v) return false;
  }
  const terms = pod.spec?.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms;
  if (terms && !terms.some((t) => termHolds(t, node))) return false;
  const tolerations = pod.spec?.tolerations ?? [];
  return (node.spec?.taints ?? [])
    .filter((t) => t.effect === 'NoSchedule' || t.effect === 'NoExecute')
    .every((t) => tolerates(tolerations, t));
}

// A container that sets only a limit is admitted with request = limit.
function containerRequest(c: RawContainer, resource: 'cpu' | 'memory'): number {
  const q = c.resources?.requests?.[resource] ?? c.resources?.limits?.[resource] ?? '0';
  return parseK8sQuantity(q) ?? 0;
}

/** The scheduler's view: max(sum of containers, largest init container) + overhead. */
function requests(pod: RawPod): { cpu: number; memory: number } {
  const of = (resource: 'cpu' | 'memory'): number => {
    const sum = (pod.spec?.containers ?? []).reduce((acc, c) => acc + containerRequest(c, resource), 0);
    const init = Math.max(0, ...(pod.spec?.initContainers ?? []).map((c) => containerRequest(c, resource)));
    const overhead = parseK8sQuantity(pod.spec?.overhead?.[resource] ?? '0') ?? 0;
    return Math.max(sum, init) + overhead;
  };
  return { cpu: of('cpu'), memory: of('memory') };
}

function podsAndRequestsByNode(pods: readonly RawPod[]): Map<string, { count: number; cpu: number; memory: number }> {
  const byNode = new Map<string, { count: number; cpu: number; memory: number }>();
  for (const p of pods) {
    const node = p.spec?.nodeName;
    if (!node || p.status?.phase === 'Succeeded' || p.status?.phase === 'Failed') continue;
    const r = requests(p);
    const cur = byNode.get(node) ?? { count: 0, cpu: 0, memory: 0 };
    byNode.set(node, { count: cur.count + 1, cpu: cur.cpu + r.cpu, memory: cur.memory + r.memory });
  }
  return byNode;
}

function fits(pod: RawPod, node: RawNode, used: { count: number; cpu: number; memory: number } | undefined): boolean {
  const alloc = node.status?.allocatable ?? {};
  const cpu = parseK8sQuantity(alloc.cpu ?? '');
  const memory = parseK8sQuantity(alloc.memory ?? '');
  const podsCap = parseK8sQuantity(alloc.pods ?? '');
  // Unreadable capacity is "unknown", not "room": a wrong yes strands a replica.
  if (cpu === null || memory === null || podsCap === null) return false;
  const u = used ?? { count: 0, cpu: 0, memory: 0 };
  const r = requests(pod);
  return u.count + 1 <= podsCap && u.cpu + r.cpu <= cpu && u.memory + r.memory <= memory;
}

function placeable(node: RawNode): boolean {
  return Boolean(node.metadata?.name)
    && !node.metadata?.deletionTimestamp
    && node.spec?.unschedulable !== true
    && isTrue(node.status?.conditions, 'Ready');
}

function settledDeployments(deployments: readonly RawDeployment[]): Map<string, string> {
  // key `<ns>/<name>` → workload label, for Deployments with every replica updated and Ready.
  const out = new Map<string, string>();
  for (const d of deployments) {
    const ns = d.metadata?.namespace;
    const name = d.metadata?.name;
    const want = d.spec?.replicas ?? 1;
    const s = d.status ?? {};
    if (!ns || !name || want < 2) continue;
    if ((s.observedGeneration ?? 0) < (d.metadata?.generation ?? 0)) continue;
    if (s.replicas !== want || s.updatedReplicas !== want || s.readyReplicas !== want || s.availableReplicas !== want) continue;
    out.set(`${ns}/${name}`, `Deployment/${name}`);
  }
  return out;
}

function settledStatefulSets(sets: readonly RawStatefulSet[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of sets) {
    const ns = s.metadata?.namespace;
    const name = s.metadata?.name;
    const want = s.spec?.replicas ?? 1;
    const st = s.status ?? {};
    if (!ns || !name || want < 2) continue;
    if ((st.observedGeneration ?? 0) < (s.metadata?.generation ?? 0)) continue;
    if (st.replicas !== want || st.readyReplicas !== want) continue;
    if (!st.currentRevision || st.currentRevision !== st.updateRevision) continue;
    out.set(`${ns}/${name}`, `StatefulSet/${name}`);
  }
  return out;
}

/** The settled workload a pod belongs to, or null. */
function workloadOf(pod: RawPod, deployments: Map<string, string>, sets: Map<string, string>): string | null {
  const ns = pod.metadata?.namespace;
  const owner = (pod.metadata?.ownerReferences ?? []).find((o) => o.controller !== false);
  if (!ns || !owner?.name) return null;
  if (owner.kind === 'StatefulSet') return sets.has(`${ns}/${owner.name}`) ? `${ns}/${owner.name}` : null;
  if (owner.kind !== 'ReplicaSet') return null;
  // A Deployment's ReplicaSet is `<deployment>-<pod-template-hash>`.
  const hash = pod.metadata?.labels?.['pod-template-hash'];
  if (!hash || !owner.name.endsWith(`-${hash}`)) return null;
  const deployment = owner.name.slice(0, -(hash.length + 1));
  return deployments.has(`${ns}/${deployment}`) ? `${ns}/${deployment}` : null;
}

function createdAt(pod: RawPod): number {
  const t = pod.metadata?.creationTimestamp;
  return t ? new Date(t).getTime() : 0;
}

/** Which doubled-up replicas to move this pass. Pure. */
export function planRebalance(input: RebalanceInput): PlannedEviction[] {
  const allowed = new Set(input.namespaces ?? REBALANCE_NAMESPACES);
  const deployments = settledDeployments(input.deployments.filter((d) => allowed.has(d.metadata?.namespace ?? '')));
  const sets = settledStatefulSets(input.statefulSets.filter((s) => allowed.has(s.metadata?.namespace ?? '')));
  const used = podsAndRequestsByNode(input.pods);
  const nodes = input.nodes.filter(placeable);

  // Running, Ready, not-terminating pods of settled workloads, grouped by workload.
  const groups = new Map<string, RawPod[]>();
  for (const p of input.pods) {
    if (!allowed.has(p.metadata?.namespace ?? '')) continue;
    if (p.metadata?.deletionTimestamp || p.status?.phase !== 'Running' || !isTrue(p.status?.conditions, 'Ready')) continue;
    if (!p.spec?.nodeName || !p.metadata?.name) continue;
    const key = workloadOf(p, deployments, sets);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }

  const plan: PlannedEviction[] = [];
  for (const [key, pods] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const perNode = new Map<string, RawPod[]>();
    for (const p of pods) perNode.set(p.spec!.nodeName!, [...(perNode.get(p.spec!.nodeName!) ?? []), p]);
    const crowded = [...perNode.entries()]
      .filter(([, ps]) => ps.length > 1)
      .sort(([a, x], [b, y]) => y.length - x.length || a.localeCompare(b));
    if (crowded.length === 0 || input.coolingDown?.has(key)) continue;
    const [fromNode, onIt] = crowded[0]!;
    // Newest first: a leader-elected workload's leader is usually its oldest pod.
    const candidate = [...onIt].sort((a, b) => createdAt(b) - createdAt(a))[0]!;
    if (!hasHardPerNodeRule(candidate) || mountsClaim(candidate) || hasUnmodelledPlacement(candidate)) continue;
    const room = nodes.find((n) => {
      const name = n.metadata!.name!;
      return !perNode.has(name) && podSelectsNode(candidate, n) && fits(candidate, n, used.get(name));
    });
    if (!room) continue;
    const ns = key.slice(0, key.indexOf('/'));
    plan.push({
      key,
      namespace: ns,
      pod: candidate.metadata!.name!,
      workload: deployments.get(key) ?? sets.get(key) ?? key,
      fromNode,
      roomOn: room.metadata!.name!,
    });
  }
  return plan;
}

/**
 * After a move, leave that workload alone this long — the replacement may
 * still be pulling its image on the new node, and a workload that keeps
 * doubling up for a reason this pass cannot see should not lose a replica
 * every five minutes. Per platform-api process: a new lease holder may move it
 * once sooner, which the settled-workload check still bounds.
 */
export const REBALANCE_COOLDOWN_MS = 30 * 60 * 1000;
const lastMoved = new Map<string, number>();

function coolingDown(now: number): Set<string> {
  for (const [k, at] of lastMoved) if (now - at >= REBALANCE_COOLDOWN_MS) lastMoved.delete(k);
  return new Set(lastMoved.keys());
}

function statusOf(err: unknown): number | undefined {
  return (err as { code?: number }).code ?? (err as { statusCode?: number }).statusCode;
}

/** List, plan, evict. Returns how many replicas were moved and what failed. */
export async function rebalanceReplicas(k8s: K8sClients): Promise<{ readonly evicted: number; readonly errors: readonly string[] }> {
  let lists: [{ items?: RawNode[] }, { items?: RawPod[] }, { items?: RawDeployment[] }, { items?: RawStatefulSet[] }];
  try {
    lists = await Promise.all([
      k8s.core.listNode({}) as Promise<{ items?: RawNode[] }>,
      k8s.core.listPodForAllNamespaces({ fieldSelector: 'status.phase!=Succeeded,status.phase!=Failed' }) as Promise<{ items?: RawPod[] }>,
      k8s.apps.listDeploymentForAllNamespaces({}) as Promise<{ items?: RawDeployment[] }>,
      k8s.apps.listStatefulSetForAllNamespaces({}) as Promise<{ items?: RawStatefulSet[] }>,
    ]);
  } catch (err) {
    // Nothing moves on a partial picture; the next pass reads again.
    return { evicted: 0, errors: [`rebalance: could not read the cluster: ${(err as Error).message}`] };
  }
  const [nodes, pods, deployments, statefulSets] = lists;
  const now = Date.now();
  const plan = planRebalance({
    coolingDown: coolingDown(now),
    nodes: nodes.items ?? [],
    pods: pods.items ?? [],
    deployments: deployments.items ?? [],
    statefulSets: statefulSets.items ?? [],
  });

  const evict = (k8s.core as unknown as {
    createNamespacedPodEviction: (req: { name: string; namespace: string; body: unknown }) => Promise<unknown>;
  }).createNamespacedPodEviction.bind(k8s.core);
  const errors: string[] = [];
  let evicted = 0;
  for (const e of plan) {
    try {
      await evict({
        name: e.pod,
        namespace: e.namespace,
        body: { apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name: e.pod, namespace: e.namespace } },
      });
      evicted += 1;
      lastMoved.set(e.key, now);
      console.log(`[system-pod-placement] ${e.namespace}/${e.workload}: two replicas on ${e.fromNode} — moved ${e.pod} (room on ${e.roomOn})`);
    } catch (err) {
      const code = statusOf(err);
      if (code === 404) continue; // already gone
      if (code === 429) {
        console.log(`[system-pod-placement] ${e.namespace}/${e.workload}: ${e.pod} stays on ${e.fromNode} for now — its disruption budget allows no eviction`);
        continue;
      }
      errors.push(`evict ${e.namespace}/${e.pod}: ${(err as Error).message}`);
    }
  }
  return { evicted, errors };
}

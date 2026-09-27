/**
 * "The node is full of promises, not work" — the CPU reservation finding.
 *
 * Kubernetes places pods by what they RESERVE (`requests`), never by what they
 * use. When the two drift apart the node fills up on paper while sitting idle,
 * and the symptoms arrive somewhere else entirely: pods that will not schedule,
 * and maintenance work preempting tenant applications to claim a slot. On a
 * production cluster this presented to the operator as a *memory* error on a
 * tenant using a quarter of the memory it was charged for.
 *
 * Nothing surfaced the actual condition, because the panel showed one number —
 * reserved — and called it usage. This finding says both, and only fires on the
 * GAP between them.
 *
 * ★ A busy node is NOT this finding. Reserved 98% / used 95% is real capacity
 * pressure and wants a different conversation (buy more, or move something).
 * What this reports is reserved 98% / used 20%: capacity that exists, is paid
 * for, and cannot be scheduled onto. Firing on high reservation alone would
 * make it noise on exactly the clusters that are correctly provisioned.
 *
 * See ADR-062. This is the R1 "diagnosis" half, which changes no behaviour.
 */

import type { DashboardAlert } from '@insula/api-contracts';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { alert } from './alerts.js';

/** Reserved fraction below which there is nothing to say, however idle. */
const RESERVED_WARN = 0.85;
/** Reserved fraction at which scheduling is about to start failing. */
const RESERVED_CRITICAL = 0.95;
/**
 * How far reserved must exceed used, in percentage points, before the gap is
 * the story. 30 points tolerates ordinary headroom — a workload that reserves
 * 500m and averages 350m is sized sensibly, not wastefully.
 */
const GAP_POINTS = 30;
/** Don't name a pod as an over-reserver for a rounding error. */
const MIN_RECLAIMABLE_MILLICORES = 50;

export interface NodeReservation {
  readonly name: string;
  /** Schedulable CPU, in millicores (capacity minus systemReserved etc.). */
  readonly allocatableMillis: number;
  /** Sum of pod requests bound to this node, in millicores. */
  readonly requestedMillis: number;
  /** Actual CPU in use, in millicores. Null when metrics are unavailable. */
  readonly usedMillis: number | null;
}

export interface PodReservation {
  readonly namespace: string;
  readonly name: string;
  readonly requestedMillis: number;
  readonly usedMillis: number;
}

/**
 * Millicores a pod reserves but does not use. Never negative: a pod over its
 * request is bursting, which is the model working, not waste to reclaim.
 */
export function reclaimableMillis(p: PodReservation): number {
  return Math.max(0, p.requestedMillis - p.usedMillis);
}

/**
 * Decide whether the gap is worth reporting, and at what severity.
 *
 * Returns null when metrics are unavailable — an unknown `used` cannot
 * establish a gap, and guessing one would be worse than staying quiet.
 */
export function assessNode(n: NodeReservation): { severity: 'warning' | 'critical'; reservedPct: number; usedPct: number } | null {
  if (n.allocatableMillis <= 0) return null;
  if (n.usedMillis === null) return null;
  const reserved = n.requestedMillis / n.allocatableMillis;
  const used = n.usedMillis / n.allocatableMillis;
  if (reserved < RESERVED_WARN) return null;
  const reservedPct = Math.round(reserved * 100);
  const usedPct = Math.round(used * 100);
  if (reservedPct - usedPct < GAP_POINTS) return null;
  return {
    severity: reserved >= RESERVED_CRITICAL ? 'critical' : 'warning',
    reservedPct,
    usedPct,
  };
}

const fmtCores = (millis: number): string => (millis / 1000).toFixed(2);

/**
 * The same figures the tile shows, shaped for the notification templates.
 *
 * Built from ONE assessment so the tile and the email can never disagree —
 * a banner that fires on one field and prints another is how an operator
 * ends up chasing a number nobody measured.
 */
export interface CpuReservationNotice {
  readonly nodeName: string;
  readonly reservedPct: string;
  readonly usedPct: string;
  readonly freeCores: string;
  readonly slackSummary: string;
  readonly recommendedAction: string;
}

export function buildCpuReservationNotice(
  nodes: readonly NodeReservation[],
  pods: readonly PodReservation[],
): CpuReservationNotice | null {
  const assessed = nodes
    .map((n) => ({ node: n, verdict: assessNode(n) }))
    .filter((x): x is { node: NodeReservation; verdict: NonNullable<ReturnType<typeof assessNode>> } => x.verdict !== null)
    .sort((a, b) => b.verdict.reservedPct - a.verdict.reservedPct);
  if (assessed.length === 0) return null;
  const { node, verdict } = assessed[0];
  const slack = pods
    .map(reclaimableMillis)
    .filter((m) => m >= MIN_RECLAIMABLE_MILLICORES);
  const total = slack.reduce((a, b) => a + b, 0);
  return {
    nodeName: node.name,
    reservedPct: String(verdict.reservedPct),
    usedPct: String(verdict.usedPct),
    freeCores: fmtCores(node.allocatableMillis - node.requestedMillis),
    slackSummary: total > 0
      ? `${fmtCores(total)} cores are reserved by ${slack.length} pods that are not using them.`
      : '',
    recommendedAction: 'Review the per-tenant dry run under Cluster → CPU scheduling to see what'
      + ' right-sizing would free, before changing anything.',
  };
}

/**
 * Build the finding, or null when no node shows the gap.
 *
 * Pure so the thresholds and the wording are testable without a cluster — the
 * numbers in the subtitle are the operator's own, and getting them wrong is
 * how a finding becomes something people learn to ignore.
 */
export function buildCpuReservationAlert(
  nodes: readonly NodeReservation[],
  pods: readonly PodReservation[],
): DashboardAlert | null {
  const assessed = nodes
    .map((n) => ({ node: n, verdict: assessNode(n) }))
    .filter((x): x is { node: NodeReservation; verdict: NonNullable<ReturnType<typeof assessNode>> } => x.verdict !== null)
    .sort((a, b) => b.verdict.reservedPct - a.verdict.reservedPct);

  if (assessed.length === 0) return null;
  const worst = assessed[0];

  const overReservers = [...pods]
    .map((p) => ({ p, slack: reclaimableMillis(p) }))
    .filter((x) => x.slack >= MIN_RECLAIMABLE_MILLICORES)
    .sort((a, b) => b.slack - a.slack);
  const totalSlack = overReservers.reduce((sum, x) => sum + x.slack, 0);

  const free = worst.node.allocatableMillis - worst.node.requestedMillis;

  return alert({
    categoryId: 'admin.cluster_cpu_reservation',
    severity: worst.verdict.severity,
    value: `${worst.verdict.reservedPct}%`,
    title: 'CPU is reserved but not used',
    // Both numbers, in the same sentence, because either one alone is the
    // misreading this finding exists to prevent.
    subtitle: `${worst.node.name} · ${worst.verdict.reservedPct}% reserved, ${worst.verdict.usedPct}% actually in use`
      + ` · ${fmtCores(free)} of ${fmtCores(worst.node.allocatableMillis)} cores schedulable`,
    href: '/cluster/cpu-scheduling',
    detail: [
      ['Reserved', `${fmtCores(worst.node.requestedMillis)} cores (${worst.verdict.reservedPct}%)`],
      ['Actually used', `${fmtCores(worst.node.usedMillis ?? 0)} cores (${worst.verdict.usedPct}%)`],
      ...(totalSlack > 0
        ? [['Reserved and unused', `${fmtCores(totalSlack)} cores across ${overReservers.length} pods`] as [string, string]]
        : []),
      ...overReservers.slice(0, 4).map((x) => [
        `${x.p.namespace}/${x.p.name}`,
        `reserves ${fmtCores(x.p.requestedMillis)}, uses ${fmtCores(x.p.usedMillis)}`,
      ] as [string, string]),
    ],
    note: 'Kubernetes schedules on what pods RESERVE, not what they use. A node can refuse new'
      + ' work while running almost idle, and the refusal surfaces as an unrelated-looking error'
      + ' — a quota message, or a pod evicted to make room. Right-sizing requests frees the gap.',
  });
}

// ─── cluster read ────────────────────────────────────────────────────

interface RawNode {
  metadata?: { name?: string };
  status?: { allocatable?: Record<string, string> };
}

/** `"3500m"`, `"3.5"`, `"897123456n"` — three spellings, one number. */
export function cpuToMillis(v: string | undefined): number {
  if (!v) return 0;
  if (v.endsWith('n')) return Number(v.slice(0, -1)) / 1e6;
  if (v.endsWith('u')) return Number(v.slice(0, -1)) / 1e3;
  if (v.endsWith('m')) return Number(v.slice(0, -1));
  return Number(v) * 1000;
}

/**
 * A pod is charged `max(sum(containers), max(initContainers))` for its WHOLE
 * life, not just while the init container runs. Summing containers alone
 * under-reports a pod whose init container is the larger of the two — which is
 * exactly the shape that produced a byte-identical "not enough memory" error
 * after an operator shrank the wrong number.
 */
export function podRequestMillis(spec: {
  containers?: Array<{ resources?: { requests?: Record<string, string> } }>;
  initContainers?: Array<{ resources?: { requests?: Record<string, string> } }>;
}): number {
  const main = (spec.containers ?? []).reduce((s, c) => s + cpuToMillis(c.resources?.requests?.cpu), 0);
  const init = (spec.initContainers ?? []).reduce(
    (m, c) => Math.max(m, cpuToMillis(c.resources?.requests?.cpu)), 0,
  );
  return Math.max(main, init);
}

/**
 * KNOWN, NOT FIXED HERE: `buildAdminLive`'s `nodesSection` already performs
 * its own listNode + listPodForAllNamespaces + node-metrics read, so a single
 * dashboard load issues two full cluster-wide pod listings. Consolidating
 * them means restructuring how those `collect()` sections share state, which
 * is a bigger change than this read-only release should carry. Tracked as a
 * follow-up; the reads inside THIS function are at least concurrent.
 */
export async function readCpuReservation(
  k8s: K8sClients,
  log?: { warn?: (o: unknown, m: string) => void },
): Promise<{ nodes: NodeReservation[]; pods: PodReservation[] }> {
  // Two independent cluster-wide reads — issued together rather than in
  // series. This function is called once per dashboard load and again per
  // preview load, so its latency is paid on an operator-facing path.
  const [nodeListRaw, podListRaw] = await Promise.all([
    k8s.core.listNode(),
    k8s.core.listPodForAllNamespaces(),
  ]);
  const nodeList = nodeListRaw as unknown as { items?: RawNode[] };
  const podList = podListRaw as unknown as {
    items?: Array<{
      metadata?: { name?: string; namespace?: string };
      status?: { phase?: string };
      spec?: {
        nodeName?: string;
        containers?: Array<{ resources?: { requests?: Record<string, string> } }>;
        initContainers?: Array<{ resources?: { requests?: Record<string, string> } }>;
      };
    }>;
  };

  const requestedByNode = new Map<string, number>();
  const requestByPod = new Map<string, { namespace: string; name: string; millis: number }>();
  for (const p of podList.items ?? []) {
    const node = p.spec?.nodeName;
    const phase = p.status?.phase;
    // A Succeeded or Failed pod still lists its requests but holds nothing —
    // the scheduler released them. Counting terminal pods makes reserved
    // exceed allocatable and turns reboot corpses into a finding.
    if (!node || phase === 'Succeeded' || phase === 'Failed') continue;
    const millis = podRequestMillis(p.spec ?? {});
    requestedByNode.set(node, (requestedByNode.get(node) ?? 0) + millis);
    const ns = p.metadata?.namespace ?? '?';
    const nm = p.metadata?.name ?? '?';
    requestByPod.set(`${ns}/${nm}`, { namespace: ns, name: nm, millis });
  }

  // Actual usage. A failure here must leave `usedMillis` NULL rather than 0:
  // a zero would read as "reserved 98%, used 0%" — the strongest possible
  // version of this very finding, manufactured out of a broken metrics call.
  const usedByNode = new Map<string, number>();
  const usedByPod = new Map<string, number>();
  try {
    const [nmRaw, pmRaw] = await Promise.all([
      k8s.custom.listClusterCustomObject({
        group: 'metrics.k8s.io', version: 'v1beta1', plural: 'nodes',
      }),
      k8s.custom.listClusterCustomObject({
        group: 'metrics.k8s.io', version: 'v1beta1', plural: 'pods',
      }),
    ]);
    const nm = nmRaw as { items?: Array<{ metadata?: { name?: string }; usage?: { cpu?: string } }> };
    for (const m of nm.items ?? []) {
      if (m.metadata?.name) usedByNode.set(m.metadata.name, cpuToMillis(m.usage?.cpu));
    }
    const pm = pmRaw as {
      items?: Array<{
        metadata?: { name?: string; namespace?: string };
        containers?: Array<{ usage?: { cpu?: string } }>;
      }>;
    };
    for (const m of pm.items ?? []) {
      const key = `${m.metadata?.namespace ?? '?'}/${m.metadata?.name ?? '?'}`;
      usedByPod.set(key, (m.containers ?? []).reduce((s, c) => s + cpuToMillis(c.usage?.cpu), 0));
    }
  } catch (err) {
    log?.warn?.(
      { err: err instanceof Error ? err.message : String(err) },
      'cpu-reservation: metrics unavailable — the reserved-vs-used gap cannot be assessed',
    );
    return { nodes: [], pods: [] };
  }

  const nodes: NodeReservation[] = (nodeList.items ?? []).flatMap((n) => {
    const name = n.metadata?.name;
    if (!name) return [];
    return [{
      name,
      allocatableMillis: cpuToMillis(n.status?.allocatable?.cpu),
      requestedMillis: requestedByNode.get(name) ?? 0,
      usedMillis: usedByNode.has(name) ? usedByNode.get(name)! : null,
    }];
  });

  const pods: PodReservation[] = [...requestByPod.entries()].flatMap(([key, v]) => {
    const used = usedByPod.get(key);
    // Unknown usage cannot establish slack. Skip rather than assume zero.
    if (used === undefined) return [];
    return [{ namespace: v.namespace, name: v.name, requestedMillis: v.millis, usedMillis: used }];
  });

  return { nodes, pods };
}

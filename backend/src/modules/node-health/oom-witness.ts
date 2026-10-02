/**
 * The OOM witness — what the KERNEL recorded about a killed container.
 *
 * WHY THIS EXISTS
 * ---------------
 * The kubelet's container status cannot answer "did this container run out of
 * memory?" in either direction:
 *
 *   - Production's VictoriaMetrics pod was OOM-killed by its own memory cgroup
 *     (kernel: CONSTRAINT_MEMCG, memory.events oom_kill 2) and the kubelet
 *     reported `{exitCode: 137, reason: "Error"}`. The alert could only say
 *     "SIGKILLed, cause unconfirmed".
 *   - Exit 137 is 128+SIGKILL from ANY source. A container that simply exited
 *     137 was reported to an admin, on DEV, as a possible OOM — under the
 *     heading "Tenant evictions (memory pressure)", with advice to raise the
 *     tenant's memory limit.
 *
 * The security-probe DaemonSet watches every pod cgroup's memory.events
 * (images/security-probe/memcg.go) and publishes the counters at `data.memcg`
 * of its per-node ConfigMap. This module reads that and decides, per kill:
 *
 *   memory-limit  oom_kill rose as the container died, and so did `oom` —
 *                 the pod hit its own memory limit.
 *   node-oom      oom_kill rose but `oom` did not — the NODE ran out of memory
 *                 and the kernel picked this container. Its limit is innocent.
 *   oom           the kubelet said OOMKilled, the witness cannot add anything.
 *   not-oom       the witness saw across the exit and no counter moved: this
 *                 SIGKILL was not memory. Not reported as a memory event.
 *   unconfirmed   exit 137 and no usable evidence either way.
 *
 * "No evidence" never becomes "not an OOM": every rule below that returns
 * not-oom first establishes that the witness could have seen the kill. And
 * one kernel kill never explains two deaths — the counters are per POD, so a
 * pod's deaths are judged together and attributed by container id
 * (judgeKills).
 */

import { z } from 'zod';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { PROBE_CONFIGMAP_PREFIX, PROBE_NAMESPACE } from '../security-hardening/k8s-client.js';

const increaseSchema = z.object({
  /** Last read BEFORE the rise; 0 = the rise predates the witness seeing the pod. */
  afterMs: z.number(),
  /** The read that saw the rise. */
  atMs: z.number(),
  oom: z.number(),
  oomKill: z.number(),
  oomGroupKill: z.number(),
  /**
   * Containers whose OWN cgroup counted the kill (64-hex container ids). The
   * pod counters aggregate every container in the pod; this is what stops one
   * real kill being pinned on a sibling. Absent when the container cgroup was
   * gone before it could be read.
   */
  containerIds: z.array(z.string()).optional(),
});

const podSchema = z.object({
  firstSeenMs: z.number(),
  lastReadMs: z.number(),
  removedMs: z.number().optional(),
  /** memory.events inotify-watched since firstSeenMs — every rise read as it happened. */
  watched: z.boolean(),
  oom: z.number().optional(),
  oomKill: z.number().optional(),
  oomGroupKill: z.number().optional(),
  increases: z.array(increaseSchema).optional(),
});

export const oomWitnessSchema = z.object({
  version: z.literal(1),
  available: z.boolean(),
  reason: z.string().nullable(),
  inotify: z.boolean(),
  startedAtMs: z.number(),
  rescannedAtMs: z.number(),
  /** When the snapshot was taken; absent from the first witness build. */
  snapshotAtMs: z.number().optional(),
  overflowsMs: z.array(z.number()),
  pods: z.record(z.string(), podSchema),
});
export type OomWitness = z.infer<typeof oomWitnessSchema>;
export type OomWitnessPod = z.infer<typeof podSchema>;

export type KillCause = 'memory-limit' | 'node-oom' | 'oom' | 'unconfirmed' | 'not-oom';
/**
 * `pending`: the witness has not published a snapshot taken after this death,
 * so it cannot speak to it yet — in either direction. Found on DEV: kills
 * judged against a snapshot published 7 s BEFORE them were frozen as
 * kubelet-only verdicts; and a watched pod killed after the snapshot would
 * have read "watched, no rise" — not-oom — dropping a real OOM alert.
 */
export type KillVerdict = KillCause | 'pending';

/**
 * A container's `finishedAt` is serialized to whole seconds, so the real exit
 * is anywhere in [t, t + 1 s).
 */
const FINISHED_AT_RESOLUTION_MS = 1_000;
/** Kubelet timestamp vs probe clock — same node, so small. */
const SKEW_MS = 2_000;
/**
 * Kill to exit. The OOM killer's SIGKILL lands at once, but a process stuck
 * in uninterruptible I/O exits only when the I/O returns — and production has
 * measured 8–48 s storage stalls. Generous on purpose: too short turns a real
 * OOM into "not-oom" and drops its alert; too long can at worst pin an OOM
 * the pod really had on a neighbouring termination.
 */
const EXIT_LAG_MS = 120_000;

/**
 * Read every node's witness. Never throws: a node whose ConfigMap is missing,
 * stale-format or unparseable simply has no entry, and its kills are judged
 * on the kubelet's word alone. `onError` reports a failed LIST so "could not
 * look" is not mistaken for "looked and found nothing".
 */
export async function readOomWitnesses(
  k8s: K8sClients,
  onError?: (message: string) => void,
): Promise<Map<string, OomWitness>> {
  const out = new Map<string, OomWitness>();
  let items: ReadonlyArray<{ metadata?: { name?: string }; data?: Record<string, string> }>;
  try {
    const list = await k8s.core.listNamespacedConfigMap({
      namespace: PROBE_NAMESPACE,
      labelSelector: 'app=security-probe',
    });
    items = list.items ?? [];
  } catch (err) {
    onError?.(err instanceof Error ? err.message : String(err));
    return out;
  }
  for (const cm of items) {
    const name = cm.metadata?.name ?? '';
    if (!name.startsWith(PROBE_CONFIGMAP_PREFIX)) continue;
    const parsed = parseOomWitness(cm.data?.memcg);
    if (parsed) out.set(name.slice(PROBE_CONFIGMAP_PREFIX.length), parsed);
  }
  return out;
}

/** Decode `data.memcg`; null when absent (an older probe) or malformed. */
export function parseOomWitness(raw: string | undefined): OomWitness | null {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = oomWitnessSchema.safeParse(json);
  return result.success ? result.data : null;
}

/** One container death to judge. */
export interface KillToJudge {
  /** Caller's handle for the result. */
  readonly key: string;
  /** lib/container-termination.ts:classifyOom — 'explicit' = the kubelet said OOMKilled. */
  readonly kubelet: 'explicit' | 'inferred';
  readonly finishedAt: Date;
  /** The terminated container's id (64 hex, scheme stripped), when the kubelet gave one. */
  readonly containerId?: string;
}

/**
 * Decide why each of a pod's containers died. Pure.
 *
 * All of a pod's deaths are judged together because the witness counts at
 * POD level: one rise must never explain two deaths it cannot account for. A
 * rise that names containers explains exactly those; one that does not (the
 * container cgroup was gone before it could be read) explains at most as many
 * deaths as it counted group kills (min 1), nearest first. A death left
 * without an explanation next to a rise that was spent elsewhere stays
 * unconfirmed — an OOM did happen in that pod just then.
 */
export function judgeKills(
  kills: ReadonlyArray<KillToJudge>,
  podUid: string,
  witness: OomWitness | undefined,
): Map<string, KillVerdict> {
  const out = new Map<string, KillVerdict>();
  const fallback = (k: KillToJudge): KillCause => (k.kubelet === 'explicit' ? 'oom' : 'unconfirmed');
  if (!witness || !witness.available) {
    for (const k of kills) out.set(k.key, fallback(k));
    return out;
  }
  // Nothing about a death the snapshot predates — not even "this pod is not
  // in it": a pod born and killed since the snapshot is not in it either.
  const snapshotAt = witness.snapshotAtMs ?? witness.rescannedAtMs;
  const judged: KillToJudge[] = [];
  for (const k of kills) {
    if (snapshotAt < k.finishedAt.getTime() + FINISHED_AT_RESOLUTION_MS + SKEW_MS) out.set(k.key, 'pending');
    else judged.push(k);
  }
  const pod = witness.pods[podUid];
  if (!pod) {
    for (const k of judged) out.set(k.key, fallback(k));
    return out;
  }
  kills = judged;

  type Increase = NonNullable<OomWitnessPod['increases']>[number];
  const killing = (pod.increases ?? []).filter((i) =>
    (i.oomKill > 0 || i.oomGroupKill > 0) && i.afterMs > 0);
  const windowOf = (k: KillToJudge): Increase[] => {
    const t = k.finishedAt.getTime();
    // A kill at K in (afterMs, atMs] explains an exit in [K, K + EXIT_LAG_MS].
    return killing.filter((i) =>
      i.afterMs < t + FINISHED_AT_RESOLUTION_MS + SKEW_MS && i.atMs + EXIT_LAG_MS >= t - SKEW_MS);
  };
  const named = (i: Increase): readonly string[] => i.containerIds ?? [];
  // A rise that names fewer containers than it counted group kills lost one
  // (its cgroup was gone before it could be read): it can still explain a
  // death, but never rule one out.
  const complete = (i: Increase): boolean => named(i).length > 0 && named(i).length >= i.oomGroupKill;

  const explained = new Map<string, Increase>();
  const used = new Map<Increase, number>();
  // 1. Exact: the rise names this container.
  for (const k of kills) {
    if (!k.containerId) continue;
    const hit = windowOf(k).find((i) => named(i).includes(k.containerId as string));
    if (hit) {
      explained.set(k.key, hit);
      used.set(hit, (used.get(hit) ?? 0) + 1);
    }
  }
  // 2. What is left of each rise — after the deaths it names — is shared out
  //    nearest first, never beyond what it counted.
  const capacity = (i: Increase): number => Math.max(i.oomGroupKill, named(i).length, 1);
  const pairs: Array<{ k: KillToJudge; i: Increase; dist: number }> = [];
  for (const k of kills) {
    if (explained.has(k.key)) continue;
    for (const i of windowOf(k)) {
      // A complete rise lists every container it killed; a death with an id
      // that it does not list was not this kill.
      if (complete(i) && k.containerId) continue;
      pairs.push({ k, i, dist: Math.abs(k.finishedAt.getTime() - i.atMs) });
    }
  }
  pairs.sort((a, b) => a.dist - b.dist);
  for (const { k, i } of pairs) {
    if (explained.has(k.key) || (used.get(i) ?? 0) >= capacity(i)) continue;
    explained.set(k.key, i);
    used.set(i, (used.get(i) ?? 0) + 1);
  }

  for (const k of kills) {
    const hit = explained.get(k.key);
    if (hit) {
      // `oom` counts the cgroup (or a child) hitting its limit; a node-level
      // OOM kill raises oom_kill alone.
      out.set(k.key, hit.oom > 0 ? 'memory-limit' : 'node-oom');
      continue;
    }
    const t = k.finishedAt.getTime();
    const nearby = windowOf(k);
    // A rise next to this death went to another container. Only a COMPLETE
    // rise that names other containers says this one was not killed — and
    // only if this death has an id to compare; otherwise it stays open.
    const ruledOut = nearby.length > 0 && Boolean(k.containerId) && nearby.every(complete);
    if (nearby.length > 0 && !ruledOut) {
      out.set(k.key, fallback(k));
      continue;
    }
    if (!sawAcross(witness, pod, t, t - SKEW_MS, t + FINISHED_AT_RESOLUTION_MS + SKEW_MS)) {
      out.set(k.key, fallback(k));
      continue;
    }
    // The witness could have seen a kill of this container and saw none.
    // Trust an explicit OOMKilled over that — a conflict is a witness gap, not
    // a reason to deny what containerd observed.
    out.set(k.key, k.kubelet === 'explicit' ? 'oom' : 'not-oom');
  }
  return out;
}

/** One death on its own — judgeKills() for a single container. */
export function judgeKill(
  kubelet: 'explicit' | 'inferred',
  finishedAt: Date,
  podUid: string,
  witness: OomWitness | undefined,
  containerId?: string,
): KillVerdict {
  return judgeKills([{ key: 'k', kubelet, finishedAt, containerId }], podUid, witness).get('k') as KillVerdict;
}

/**
 * True when the absence of a matching rise is EVIDENCE: the witness's record
 * of this pod spans the exit and would have caught a kill.
 */
function sawAcross(
  witness: OomWitness,
  pod: OomWitnessPod,
  t: number,
  exitEarliest: number,
  exitLatest: number,
): boolean {
  const baseline = (pod.increases ?? []).some((i) => i.afterMs === 0);
  // With a baseline, history before firstSeen is a lump of unknown timing —
  // an exit before it cannot be separated from that lump.
  if (baseline && pod.firstSeenMs >= exitEarliest) return false;
  // Counters still zero when the witness first read the pod, AFTER the exit:
  // cumulative counters at zero mean no kill ever happened in this pod.
  if (!baseline && pod.firstSeenMs >= exitLatest && (pod.oomKill ?? 0) === 0 && (pod.oomGroupKill ?? 0) === 0) {
    return true;
  }
  if (pod.firstSeenMs >= exitEarliest) return false;
  // A read after the exit with no rise between it and the read before.
  if (pod.lastReadMs >= exitLatest) return true;
  // Watched live: a kill would have raised a modify event and been read then.
  // Unless events were lost around the exit.
  if (witness.inotify && pod.watched) {
    const lostNear = witness.overflowsMs.some((o) => o >= t - EXIT_LAG_MS - SKEW_MS && o <= exitLatest + EXIT_LAG_MS);
    return !lostNear;
  }
  return false;
}

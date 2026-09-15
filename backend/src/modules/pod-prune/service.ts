/**
 * Sweep dead pod records.
 *
 * Kubernetes keeps terminal pods deliberately — they are the post-mortem record
 * — and only garbage-collects them past `--terminated-pod-gc-threshold`, which
 * defaults to 12500 and is unset on our clusters. At our scale that threshold is
 * never reached, so the records accumulate monotonically with nothing to reverse
 * them: every node reboot adds a batch and none ever leave.
 *
 * What they cost, measured on production 2026-09-15 (43 records from one
 * graceful sv1 shutdown):
 *
 *   node CPU/memory   nothing — the containers are gone, cgroups torn down
 *   scheduling        nothing — the scheduler counts non-terminated pods only
 *   ResourceQuota     nothing — Kubernetes excludes terminal pods by design
 *   container logs    ~102 MB, held until the POD OBJECT is deleted
 *   etcd + watch      ~12 KB each; noise at this scale
 *
 * The log directory is the real cost, and it is bounded per container
 * (containerLogMaxSize 10Mi x containerLogMaxFiles 5 = 50 MiB) but NOT in
 * aggregate: the ceiling is that cap times the number of retained containers,
 * and the number of retained containers is bounded only by 12500.
 *
 * The other cost is correctness — a terminal pod is a complete Pod object, so
 * any scan that reads pods from a list sees a workload that is not running.
 * That has bitten twice: PR #517 (corpses misreported as tenant OOM kills) and
 * the reserved-memory over-count fixed alongside this module.
 */
import type * as k8s from '@kubernetes/client-node';
import type { PodPruneEntry, PodPruneResult, PodPruneSkipReason } from '@insula/api-contracts';

/** Terminal phases. A pod in one of these will never run again. */
const TERMINAL_PHASES = new Set(['Succeeded', 'Failed']);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface PodLike {
  readonly metadata?: {
    readonly name?: string;
    readonly namespace?: string;
    readonly creationTimestamp?: string | Date;
    readonly ownerReferences?: ReadonlyArray<{ readonly kind?: string; readonly name?: string }>;
  };
  readonly status?: {
    readonly phase?: string;
    readonly containerStatuses?: ReadonlyArray<{
      readonly state?: { readonly terminated?: { readonly finishedAt?: string | Date } };
    }>;
  };
}

export interface PrunePodsArgs {
  readonly core: k8s.CoreV1Api;
  readonly batch: k8s.BatchV1Api;
  /** Only prune records at least this old. 0 = every dead record. */
  readonly olderThanDays: number;
  /** Report what WOULD be pruned without deleting. */
  readonly dryRun?: boolean;
  readonly now?: Date;
  readonly log?: { warn: (msg: string) => void };
}

/**
 * When did this pod actually stop?
 *
 * The latest container `finishedAt` is the honest answer; `creationTimestamp` is
 * the fallback for a record whose container statuses were pruned or never set
 * (an evicted pod that never started a container has no finishedAt at all).
 */
export function podFinishedAt(pod: PodLike): Date | null {
  let latest: number | null = null;
  for (const cs of pod.status?.containerStatuses ?? []) {
    const f = cs.state?.terminated?.finishedAt;
    if (!f) continue;
    const t = new Date(f).getTime();
    if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t;
  }
  if (latest !== null) return new Date(latest);
  const created = pod.metadata?.creationTimestamp;
  if (created) {
    const t = new Date(created).getTime();
    if (!Number.isNaN(t)) return new Date(t);
  }
  return null;
}

export function isTerminalPod(pod: PodLike): boolean {
  return TERMINAL_PHASES.has(pod.status?.phase ?? '');
}

function entryFor(pod: PodLike, now: Date): PodPruneEntry {
  const finished = podFinishedAt(pod);
  return {
    namespace: pod.metadata?.namespace ?? '',
    name: pod.metadata?.name ?? '',
    phase: pod.status?.phase ?? 'Unknown',
    finishedAt: finished ? finished.toISOString() : null,
    ageDays: finished
      ? Math.round(((now.getTime() - finished.getTime()) / MS_PER_DAY) * 100) / 100
      : 0,
  };
}

/**
 * Is this record owned by a Job that still wants completions?
 *
 * This is the ONE case where pruning is not harmless tidy-up. A Job tracks
 * success by counting its succeeded pods; delete one while the Job is still
 * running and the Job creates a replacement and does the work AGAIN. For a
 * backup or a migration that is a real side effect, so these are always skipped
 * regardless of age.
 *
 * A Job that has finished (completionTime set, nothing active) will not recreate
 * anything, so its pods are prunable like any other.
 */
async function jobStillActive(
  batch: k8s.BatchV1Api,
  namespace: string,
  jobName: string,
  cache: Map<string, boolean>,
): Promise<boolean> {
  const key = `${namespace}/${jobName}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let active = false;
  try {
    const job = await batch.readNamespacedJob({ name: jobName, namespace } as never) as {
      status?: { active?: number; completionTime?: string };
    };
    active = (job.status?.active ?? 0) > 0 || !job.status?.completionTime;
  } catch {
    // Job is gone: nothing can recreate the pod, so it is safe to prune.
    active = false;
  }
  cache.set(key, active);
  return active;
}

export async function prunePods(args: PrunePodsArgs): Promise<PodPruneResult> {
  const now = args.now ?? new Date();
  const cutoffMs = args.olderThanDays * MS_PER_DAY;

  const list = await args.core.listPodForAllNamespaces() as unknown as { items?: readonly PodLike[] };
  const dead = (list.items ?? []).filter(isTerminalPod);

  const pruned: PodPruneEntry[] = [];
  const skipped: Array<PodPruneEntry & { reason: PodPruneSkipReason }> = [];
  const jobCache = new Map<string, boolean>();

  for (const pod of dead) {
    const entry = entryFor(pod, now);
    const finished = podFinishedAt(pod);

    // A record with no usable timestamp is treated as age 0, so it survives any
    // non-zero window rather than being swept on a guess.
    if (cutoffMs > 0) {
      if (!finished || now.getTime() - finished.getTime() < cutoffMs) {
        skipped.push({ ...entry, reason: 'too_young' });
        continue;
      }
    }

    const owner = (pod.metadata?.ownerReferences ?? []).find((o) => o.kind === 'Job');
    if (owner?.name && await jobStillActive(args.batch, entry.namespace, owner.name, jobCache)) {
      skipped.push({ ...entry, reason: 'job_still_active' });
      continue;
    }

    if (args.dryRun) {
      pruned.push(entry);
      continue;
    }

    try {
      await args.core.deleteNamespacedPod({
        name: entry.name,
        namespace: entry.namespace,
      } as never);
      pruned.push(entry);
    } catch (err) {
      args.log?.warn(
        `pod-prune: could not delete ${entry.namespace}/${entry.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      skipped.push({ ...entry, reason: 'delete_failed' });
    }
  }

  return {
    scanned: dead.length,
    pruned,
    skipped,
    message: buildMessage(dead.length, pruned.length, skipped, args.dryRun ?? false),
  };
}

function buildMessage(
  scanned: number,
  prunedCount: number,
  skipped: ReadonlyArray<{ reason: PodPruneSkipReason }>,
  dryRun: boolean,
): string {
  if (scanned === 0) return 'No dead pod records found — nothing to prune.';
  const verb = dryRun ? 'Would remove' : 'Removed';
  const parts = [`${verb} ${prunedCount} of ${scanned} dead pod record(s).`];

  const tooYoung = skipped.filter((s) => s.reason === 'too_young').length;
  const jobActive = skipped.filter((s) => s.reason === 'job_still_active').length;
  const failed = skipped.filter((s) => s.reason === 'delete_failed').length;

  if (tooYoung > 0) parts.push(`${tooYoung} newer than the retention window.`);
  // Worth saying out loud: this one is a safety rule, not a policy the operator
  // can shorten their way past.
  if (jobActive > 0) {
    parts.push(
      `${jobActive} belong to a Job that has not finished and were left alone — `
      + 'removing those would make the Job run the work again.',
    );
  }
  if (failed > 0) parts.push(`${failed} could not be deleted — see server logs.`);
  if (!dryRun && prunedCount > 0) {
    parts.push('Their container logs are released once kubelet finishes housekeeping.');
  }
  return parts.join(' ');
}

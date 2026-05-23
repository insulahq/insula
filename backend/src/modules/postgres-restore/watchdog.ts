/**
 * PITR Job watchdog — Phase 4 (2026-05-23) follow-up.
 *
 * Symptom this fixes: when the PITR Job's pod creation is rejected
 * (most commonly ResourceQuota `FailedCreate` during a platform-api
 * rollout transient), the Job CR exists, kubernetes retries pod
 * creation up to backoffLimit (default 6), then the Job is marked
 * Failed. By then ttlSecondsAfterFinished is up and the Job CR is
 * GC'd. The pitr-job pod NEVER ran, so it never called finishByRef +
 * never released the PITR lock. Result:
 *   - task-center chip stuck in 'running' forever
 *   - PITR lock held forever
 *   - operator can't trigger another restore (409 PRECONDITION_FAILED)
 *
 * Watchdog behavior:
 *   1. Every 60s, list Jobs labeled
 *      `platform.phoenix-host.net/pitr-restore=true`.
 *   2. For each Job: if age > STUCK_THRESHOLD_MS AND Job has no
 *      Active+Succeeded pods AND there are FailedCreate events,
 *      declare it stuck.
 *   3. Finalize the matching chip (kind='postgres.pitr' OR
 *      'postgres.barman-promote', refId=Job.metadata.name) as failed
 *      via finalizeByRef (INSERT-or-UPDATE: also rebuilds the chip if
 *      the post-cutover DB rewound it).
 *   4. Release the PITR lock (the in-memory + DB-persisted state).
 *   5. Delete the stuck Job CR so it stops chewing through the
 *      backoffLimit retries.
 *
 * Read-only by default — when DELETE_STUCK_JOBS=false the watchdog
 * only finalizes the chip + lock + logs the manual command. This is
 * the SAFE-FIRST default; flip via env when operators are confident.
 */

import type { Logger } from 'pino';
import type { Database } from '../../db/index.js';
import { releasePitrLock } from './service.js';
import { finalizeByRef } from '../tasks/service.js';
import { toSafeText } from '@k8s-hosting/api-contracts';

// Tunables — exported for testing.
export const WATCHDOG_INTERVAL_MS = 60_000;
export const STUCK_THRESHOLD_MS = 90_000;
const PITR_LABEL_SELECTOR = 'platform.phoenix-host.net/pitr-restore=true';

interface PitrJob {
  readonly metadata?: {
    readonly name?: string;
    readonly namespace?: string;
    readonly creationTimestamp?: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly annotations?: Readonly<Record<string, string>>;
  };
  readonly spec?: {
    readonly template?: {
      readonly spec?: {
        readonly containers?: ReadonlyArray<{
          readonly env?: ReadonlyArray<{ readonly name: string; readonly value?: string }>;
        }>;
      };
    };
  };
  readonly status?: {
    readonly active?: number;
    readonly succeeded?: number;
    readonly failed?: number;
    readonly conditions?: ReadonlyArray<{
      readonly type?: string;
      readonly status?: string;
      readonly reason?: string;
      readonly message?: string;
    }>;
  };
}

interface JobEvent {
  readonly reason?: string;
  readonly message?: string;
  readonly lastTimestamp?: string;
  readonly involvedObject?: { readonly kind?: string; readonly name?: string };
}

export interface PitrWatchdogDeps {
  readonly db: Database;
  readonly k8s: {
    readonly batch: {
      readonly listNamespacedJob: (
        a: { namespace: string; labelSelector?: string },
      ) => Promise<{ items?: ReadonlyArray<PitrJob> }>;
      readonly deleteNamespacedJob: (
        a: { namespace: string; name: string; propagationPolicy?: string },
      ) => Promise<unknown>;
    };
    readonly core: {
      readonly listNamespacedEvent: (
        a: { namespace: string; fieldSelector?: string },
      ) => Promise<{ items?: ReadonlyArray<JobEvent> }>;
    };
  };
  readonly log?: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** When true (default false) the watchdog DELETEs stuck Jobs after
   *  finalizing the chip. Safe to leave off — Jobs eventually hit TTL. */
  readonly deleteStuckJobs?: boolean;
  /** Override for tests — default scans `platform` namespace. */
  readonly namespace?: string;
}

interface StuckJobReason {
  readonly job: PitrJob;
  readonly reason: string;
  readonly evidence: string;
}

/**
 * Single reconciliation pass. Exported for unit tests.
 *
 * Returns the list of jobs identified as stuck + the action taken
 * for each. Idempotent — running this twice on the same stuck Job
 * is harmless (finalizeByRef is upsert; releasePitrLock no-ops if
 * lock already released).
 */
export async function reconcilePitrJobsOnce(
  deps: PitrWatchdogDeps,
): Promise<ReadonlyArray<StuckJobReason>> {
  const namespace = deps.namespace ?? 'platform';
  const log = deps.log;

  let listing: { items?: ReadonlyArray<PitrJob> };
  try {
    listing = await deps.k8s.batch.listNamespacedJob({ namespace, labelSelector: PITR_LABEL_SELECTOR });
  } catch (err) {
    log?.warn?.({ err: (err as Error).message }, 'pitr-watchdog: list jobs failed');
    return [];
  }

  const items = listing.items ?? [];
  const stuck: StuckJobReason[] = [];
  const now = Date.now();

  for (const job of items) {
    const name = job.metadata?.name;
    const createdAt = job.metadata?.creationTimestamp;
    if (!name || !createdAt) continue;

    const ageMs = now - new Date(createdAt).getTime();
    if (ageMs < STUCK_THRESHOLD_MS) continue; // not old enough to judge

    const active = job.status?.active ?? 0;
    const succeeded = job.status?.succeeded ?? 0;
    const failedCount = job.status?.failed ?? 0;
    if (active > 0 || succeeded > 0) continue; // healthy

    // Look for FailedCreate events on this Job.
    let failedCreateEvents: ReadonlyArray<JobEvent> = [];
    try {
      const evList = await deps.k8s.core.listNamespacedEvent({
        namespace,
        fieldSelector: `involvedObject.name=${name}`,
      });
      failedCreateEvents = (evList.items ?? []).filter((e) => e.reason === 'FailedCreate');
    } catch (err) {
      log?.warn?.({ err: (err as Error).message, name }, 'pitr-watchdog: list events failed');
    }

    if (failedCreateEvents.length === 0 && failedCount === 0) continue; // not declared stuck yet
    const stuckEvidence = failedCreateEvents.length > 0
      ? `${failedCreateEvents.length} FailedCreate events; latest: ${(failedCreateEvents[failedCreateEvents.length - 1].message ?? '').slice(0, 200)}`
      : `Job.status.failed=${failedCount}, no Active/Succeeded pods`;
    stuck.push({ job, reason: 'no-pod-ever-scheduled', evidence: stuckEvidence });
    log?.warn?.({ name, ageMs, evidence: stuckEvidence }, 'pitr-watchdog: declaring Job stuck');

    // Derive the chip kind from Job pod-template env vars: pitr-job
    // pod has BARMAN_PROMOTE_MODE='true' when invoked from Phase 3.1.
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const isPromote = env.some((e) => e.name === 'BARMAN_PROMOTE_MODE' && e.value === 'true');
    const chipKind = isPromote ? 'postgres.barman-promote' : 'postgres.pitr';
    const clusterNamespace = env.find((e) => e.name === 'PITR_CLUSTER_NAMESPACE')?.value ?? namespace;
    const clusterName = env.find((e) => e.name === 'PITR_CLUSTER_NAME')?.value ?? 'unknown';
    const snapshotName = env.find((e) => e.name === 'PITR_SNAPSHOT_NAME')?.value ?? 'unknown';
    const actorUserId = env.find((e) => e.name === 'PITR_ACTOR_USER_ID')?.value ?? null;

    // Finalize chip + release lock. Both are best-effort; orchestrator
    // may have raced + cleaned up between our check and now.
    try {
      if (actorUserId) {
        await finalizeByRef(deps.db, chipKind, name, {
          status: 'failed',
          error: `Watchdog: ${stuckEvidence}`,
          detailsPatch: {
            watchdog: true,
            stuckReason: 'no-pod-ever-scheduled',
            evidence: stuckEvidence,
            finishedAtIso: new Date().toISOString(),
            mode: isPromote ? 'barman-promote' : 'pitr',
            clusterName,
            snapshotName,
          },
          recreate: {
            scope: 'admin' as const,
            userId: actorUserId,
            label: toSafeText(`Postgres ${isPromote ? 'barman-promote' : 'PITR'} (${clusterNamespace}/${clusterName})`),
            target: {
              type: 'modal' as const,
              modal: 'pitr-progress',
              modalProps: { jobName: name, clusterNamespace, clusterName },
            },
            details: { clusterNamespace, clusterName, snapshotName },
          },
        });
      }
    } catch (err) {
      log?.error?.({ err: (err as Error).message, name }, 'pitr-watchdog: finalizeByRef failed (non-fatal)');
    }

    try {
      await releasePitrLock(deps.db, {
        failed: true,
        error: `Watchdog: ${stuckEvidence}`,
        taskKind: chipKind,
      });
    } catch (err) {
      log?.error?.({ err: (err as Error).message, name }, 'pitr-watchdog: releasePitrLock failed (non-fatal)');
    }

    if (deps.deleteStuckJobs) {
      try {
        await deps.k8s.batch.deleteNamespacedJob({ namespace, name, propagationPolicy: 'Background' });
        log?.info?.({ name }, 'pitr-watchdog: deleted stuck Job');
      } catch (err) {
        log?.error?.({ err: (err as Error).message, name }, 'pitr-watchdog: delete Job failed');
      }
    }
  }

  return stuck;
}

/**
 * Start the periodic watchdog. Returns a stop() handle the host
 * (typically app.ts onClose) can call for graceful shutdown.
 */
export function startPitrJobWatchdog(deps: PitrWatchdogDeps): { readonly stop: () => void } {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await reconcilePitrJobsOnce(deps);
    } catch (err) {
      deps.log?.error?.({ err: (err as Error).message }, 'pitr-watchdog: tick failed');
    }
  };

  const timer = setInterval(() => { void tick(); }, WATCHDOG_INTERVAL_MS);
  // Run once immediately so a fresh platform-api restart doesn't have
  // to wait a full interval before catching pre-existing stuck Jobs.
  setImmediate(() => { void tick(); });

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

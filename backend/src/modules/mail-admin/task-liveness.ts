/**
 * Liveness leases for long-running mail tasks.
 *
 * A mail migration (and a port-exposure flip) runs as a promise inside ONE
 * platform-api replica. Its rows — mail_migration_runs and the task-center row —
 * say "running" for as long as it lasts, and the orphan reaper (orphan-reaper.ts)
 * fails rows whose owner is gone. "Gone" used to mean "older than 60 s when some
 * replica booted", so in HA any replica starting mid-run failed another replica's
 * LIVE migration — a deploy, or during a DR failover the replica the dead node
 * took down, rescheduled while the failover runs. With the run out of "in
 * flight", the guards keyed on that (placement start-up reconcile, active-node
 * persist) stopped protecting it.
 *
 * The owner now holds one lease per row id while the work runs — the scheduler
 * lease (shared/scheduler-lease.ts: platform_settings, database clock), renewed
 * every TTL/3. A dead owner stops renewing and its lease runs out within the TTL;
 * the reaper takes only rows whose lease is missing or expired.
 *
 * Bookkeeping never blocks the work: a lease that cannot be taken or renewed is
 * logged and the task runs anyway (the reaper then gives the row a 10-minute
 * grace before treating it as orphaned).
 *
 * A graceful shutdown releases these leases with the scheduler's
 * (releaseAllSchedulerLeases): the process closes its database and exits right
 * after, so its migration dies with it and the run IS orphaned — the next
 * reaper pass may take it at once instead of waiting out the TTL.
 */
import {
  claimSchedulerLease,
  releaseSchedulerLease,
  type LeaseDb,
} from '../../shared/scheduler-lease.js';

/** Lease lifetime; renewed every third of it while the task runs. */
export const MAIL_TASK_LIVENESS_TTL_MS = 90_000;

/** The scheduler-lease job name of a mail task's liveness lease. */
export function mailTaskLeaseName(id: string): string {
  return `mail-task:${id}`;
}

export interface LivenessLog {
  readonly warn: (...args: unknown[]) => void;
}

/**
 * Run `fn` while holding the liveness lease of every id in `ids` (a run id, its
 * task id — nullish entries are skipped). The leases are released when `fn`
 * settles, whether it resolves or throws.
 */
export async function withMailTaskLiveness<T>(
  db: LeaseDb,
  ids: ReadonlyArray<string | null | undefined>,
  fn: () => Promise<T>,
  log?: LivenessLog,
): Promise<T> {
  const names = ids.filter((id): id is string => !!id).map(mailTaskLeaseName);
  const claimAll = async (): Promise<void> => {
    for (const name of names) {
      try {
        await claimSchedulerLease(db, name, MAIL_TASK_LIVENESS_TTL_MS);
      } catch (err) {
        log?.warn(`[mail-task-liveness] could not hold ${name} (the task runs anyway):`, err instanceof Error ? err.message : String(err));
      }
    }
  };

  await claimAll();
  // A renewal still in flight when the work ends would re-create the lease right
  // after the release below — wait for it first.
  let renewing: Promise<void> = Promise.resolve();
  const timer = setInterval(() => { renewing = claimAll(); }, MAIL_TASK_LIVENESS_TTL_MS / 3);
  timer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    await renewing;
    for (const name of names) {
      await releaseSchedulerLease(db, name).catch((err: unknown) => {
        log?.warn(`[mail-task-liveness] could not release ${name} (it expires on its own):`, err instanceof Error ? err.message : String(err));
      });
    }
  }
}

/**
 * Tenant cron scheduler.
 *
 * Polls every 30s, claims each due job atomically, runs it through
 * `executeCronJob`, and records what happened. Both job types go through the
 * same path — the `type = 'webcron'` filter this loop used to carry is why a
 * deployment cron never fired.
 */

import { and, eq, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { cronJobs } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { clip, executeCronJob, describeFailure, platformInterruption, runTimeoutMs, type ClusterTransport, type CronRunResult } from './executor.js';
import { getNextRunTime } from './cron-expression.js';
import { resolveFailureEmailRecipients } from './failure-email.js';
import { failureIsReportable } from './failure-streak.js';
import {
  OUTAGE_EVIDENCE_DELAY_MS,
  PLATFORM_FAULT_RETRY_DELAY_MS,
  clusterNodeList,
  explainingOutage,
  notifyOperatorOfPlatformFault,
} from './platform-fault.js';

// The scheduling maths lives in cron-expression.ts now. Re-exported because
// this module has been its public entry point since the beginning.
export { getNextRunTime, NEVER, parseCron } from './cron-expression.js';

export interface CronSchedulerDeps {
  readonly kubeconfigPath?: string;
  /** Per-run ceiling for deployment commands. */
  readonly timeoutMs?: number;
  /** Injected in tests. */
  readonly transport?: ClusterTransport;
  readonly pollIntervalMs?: number;
  /** How long a failed deployment run waits before the interruption check (tests: 0). */
  readonly interruptionCheckDelayMs?: number;
  /** How long a run the platform could not start waits before its retry (tests: 0). */
  readonly platformFaultRetryDelayMs?: number;
  /** How long after the first platform fault the operator notice is decided (tests: 0). */
  readonly outageEvidenceDelayMs?: number;
  /** The node outage explaining a platform fault, or null (platform-fault.ts; injected in tests). */
  readonly explainingOutage?: () => Promise<string | null>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/**
 * A node shutting down stops its pods some seconds before the node itself is
 * marked NotReady (production: the cron failed at 10:10:43, the
 * node went NotReady at 10:10:52). Look again after this long.
 */
export const INTERRUPTION_CHECK_DELAY_MS = 45_000;

/**
 * Deferred checks still waiting. A timer lives in this process only: on
 * shutdown (a rolling upgrade, the pod's node going away) they are run at once
 * instead of being dropped — a genuine failure must not go unreported because
 * the API restarted inside the 45 s.
 */
const pendingFailureChecks = new Map<NodeJS.Timeout, () => Promise<void>>();

/** Run `check` after `delayMs` — or now, when that is not positive — as a pending check. */
async function deferCheck(delayMs: number, check: () => Promise<void>): Promise<void> {
  if (delayMs <= 0) {
    await check();
    return;
  }
  const timer: NodeJS.Timeout = setTimeout(() => {
    pendingFailureChecks.delete(timer);
    void check();
  }, delayMs);
  timer.unref?.();
  pendingFailureChecks.set(timer, check);
}

export async function flushPendingFailureChecks(): Promise<void> {
  const pending = [...pendingFailureChecks.entries()];
  pendingFailureChecks.clear();
  for (const [timer] of pending) clearTimeout(timer);
  await Promise.allSettled(pending.map(([, check]) => check()));
}

const DEFAULT_POLL_MS = 30_000;

/**
 * Grace added to a job's own run ceiling before its claim counts as orphaned.
 *
 * The claim is a `lastRunStatus = 'running'` marker, and nothing clears it if
 * the API pod is killed mid-run — so without a staleness window one restart at
 * the wrong moment wedges a job permanently, looking to the tenant like a cron
 * that simply stopped.
 *
 * The window is measured from the job's OWN timeout rather than one number for
 * everything. A fixed 30 minutes was safe while every run was capped at 5, but
 * a job may now be configured up to an hour: with a fixed window, a legitimate
 * 45-minute run would be re-claimed and executed a second time WHILE THE FIRST
 * IS STILL RUNNING. Deriving it from the ceiling keeps "still running" and
 * "abandoned" from ever overlapping.
 */
const CLAIM_GRACE_MS = 5 * 60_000;

/** A claim older than the job's own ceiling plus grace is an orphan. */
export function claimStaleBefore(
  job: { readonly type: string; readonly timeoutSeconds: number | null },
  now: Date,
): Date {
  return new Date(now.getTime() - (runTimeoutMs(job as never) + CLAIM_GRACE_MS));
}

/**
 * The platform's configured timezone, or null when it cannot be read.
 *
 * Null rather than a thrown error on purpose: a settings read that fails must
 * not stop every tenant's cron. The jobs fall back to UTC for that tick, which
 * is what they did before timezones existed.
 */
async function getPlatformTimeZone(db: Database): Promise<string | null> {
  try {
    const { getSettings } = await import('../system-settings/service.js');
    const settings = await getSettings(db);
    return settings.timezone ?? null;
  } catch (err) {
    console.warn('[cron-scheduler] could not read the platform timezone; using UTC this tick:',
      err instanceof Error ? err.message : err);
    return null;
  }
}

export function startCronScheduler(db: Database, deps: CronSchedulerDeps = {}): NodeJS.Timeout {
  console.log('[cron-scheduler] Starting...');

  const pollInterval = setInterval(async () => {
    try {
      const now = new Date();

      // One settings read per tick, not per job. getSettings is itself cached,
      // but a job list of any size would still hammer it.
      const platformTimeZone = await getPlatformTimeZone(db);

      const jobs = await db
        .select()
        .from(cronJobs)
        .where(eq(cronJobs.enabled, 1));

      for (const job of jobs) {
        if (!isJobDue(job, now, platformTimeZone)) continue;

        if (!(await claimJob(db, job.id, claimStaleBefore(job, now)))) continue;

        void runAndRecord(db, job, deps).catch((err) => {
          console.error(`[cron-scheduler] Error executing ${job.name}:`, err);
        });
      }
    } catch (err) {
      console.error('[cron-scheduler] Poll error:', err);
    }
  }, deps.pollIntervalMs ?? DEFAULT_POLL_MS);

  return pollInterval;
}

/**
 * The zone a job's schedule is read in.
 *
 * The job's own, else the platform's, else UTC. Resolved at evaluation time
 * rather than stamped on the row at creation, so an operator who changes the
 * platform timezone moves every job that was following it — and leaves alone
 * the ones somebody pinned on purpose.
 */
export function resolveTimeZone(
  job: { readonly timezone: string | null },
  platformTimeZone: string | null | undefined,
): string {
  return job.timezone || platformTimeZone || 'UTC';
}

/**
 * Is this job due at `now`?
 *
 * A job that has never run is measured from when it was CREATED. Measuring
 * from `now` — which is what passing a null base used to do — moves the target
 * forward on every 30-second poll, so the job is never due and sits at "Never"
 * for ever. That shipped, and a `* * * * *` Moodle cron on a real cluster is
 * what found it: the unit tests each called the helper once with a fixed
 * `now`, which is precisely the case where the bug is invisible.
 */
export function isJobDue(
  job: {
    readonly schedule: string;
    readonly lastRunAt: Date | null;
    readonly createdAt: Date;
    readonly timezone?: string | null;
  },
  now: Date,
  platformTimeZone?: string | null,
): boolean {
  const zone = resolveTimeZone({ timezone: job.timezone ?? null }, platformTimeZone);
  return getNextRunTime(job.schedule, job.lastRunAt ?? job.createdAt, now, zone) <= now;
}

/**
 * Take the job, or report that somebody else has it.
 *
 * Atomic (an UPDATE … WHERE … RETURNING), so two replicas polling the same
 * second cannot both run the job.
 *
 * `last_run_status != 'running'` alone was NOT enough, and this is the bug that
 * kept the whole feature asleep: a job that has never run carries NULL there,
 * and in SQL `NULL != 'running'` evaluates to NULL, not true. The claim matched
 * no row, the job was skipped, and it stayed skipped — so a freshly created
 * cron job never ran on schedule until somebody pressed "Run now" by hand and
 * gave the column a non-NULL value. The IS NULL arm is that fix.
 *
 * The staleness arm releases a claim orphaned by an API pod that died mid-run;
 * without it one restart at the wrong moment wedges a job for good.
 */
export async function claimJob(db: Database, jobId: string, staleBefore: Date): Promise<boolean> {
  const [claimed] = await db
    .update(cronJobs)
    .set({ lastRunStatus: 'running' })
    .where(
      and(
        eq(cronJobs.id, jobId),
        or(
          isNull(cronJobs.lastRunStatus),
          ne(cronJobs.lastRunStatus, 'running'),
          lt(cronJobs.updatedAt, staleBefore),
        ),
      ),
    )
    .returning({ id: cronJobs.id });
  return claimed !== undefined;
}

/**
 * Run one job, write the outcome, and tell the tenant when it failed.
 *
 * Exported so a manual "Run now" records exactly what a scheduled run records —
 * the two used to be separate code paths, and the manual one reported success
 * for a job type it never executed.
 */
export async function runAndRecord(
  db: Database,
  job: typeof cronJobs.$inferSelect,
  deps: CronSchedulerDeps = {},
  options: { readonly notify?: boolean; readonly retry?: boolean } = {},
): Promise<typeof cronJobs.$inferSelect | undefined> {
  const run = () => executeCronJob(db, job, {
    kubeconfigPath: deps.kubeconfigPath,
    timeoutMs: deps.timeoutMs,
    transport: deps.transport,
  });
  let result = await run();
  const firstResultAt = Date.now();
  // The platform could not reach its cluster before the command was sent:
  // running it again cannot run it twice (platform-fault.ts).
  if (result.platformFault && result.notStarted && options.retry !== false) {
    console.warn(`[cron-scheduler] job ${job.id} could not start — the platform ${result.platformFault}; trying once more`);
    await sleep(deps.platformFaultRetryDelayMs ?? PLATFORM_FAULT_RETRY_DELAY_MS);
    result = await run();
  }

  const recordedAt = new Date();
  const fault = result.platformFault;
  // Counted in the UPDATE itself: a manual run and a scheduled one finishing
  // together must not both read 1 and both write 2.
  const [recorded] = await db
    .update(cronJobs)
    .set({
      lastRunAt: recordedAt,
      lastRunStatus: result.status,
      lastRunDurationMs: result.durationMs,
      lastRunResponseCode: result.responseCode,
      lastRunOutput: result.output,
      consecutiveFailures: streakAfter(result.status, fault),
    })
    .where(eq(cronJobs.id, job.id))
    .returning({ consecutiveFailures: cronJobs.consecutiveFailures });
  const streak = recorded?.consecutiveFailures ?? 1;

  // Tell the tenant. Until the notification was added, a failed run recorded
  // itself and notified nobody — a nightly job could fail every night and the
  // only evidence was a column in a panel somebody had to think to open.
  //
  // Dedupe per (job, UTC day): a broken job on a 5-minute schedule would
  // otherwise send 288 notifications before breakfast. And a job that runs
  // again within the hour is reported on its second failure in a row, not its
  // first (failure-streak.ts).
  if (fault) {
    // The platform could not reach its own cluster: not the tenant's failure,
    // and they are not told it is. The run record says what happened; the
    // operator hears of it unless a node outage they were told about explains
    // it — decided once that outage could be visible (OUTAGE_EVIDENCE_DELAY_MS).
    console.warn(`[cron-scheduler] job ${job.id} did not run — the platform ${fault}; not reported to the tenant`);
    if (options.notify !== false) {
      const explain = deps.explainingOutage ?? (() => explainingOutage(db, clusterNodeList(deps.kubeconfigPath)));
      const wait = firstResultAt + (deps.outageEvidenceDelayMs ?? OUTAGE_EVIDENCE_DELAY_MS) - Date.now();
      await deferCheck(wait, () => notifyOperatorOfPlatformFault(db, job, fault, explain));
    }
  } else if (options.notify !== false && result.status === 'failed' && job.tenantId) {
    // Only worth waiting for when the check can run (the real cluster can; a
    // test transport without podDisruption cannot).
    const canCheck = !deps.transport || typeof deps.transport.podDisruption === 'function';
    if (job.type === 'deployment' && result.ranIn && canCheck) {
      await deferCheck(deps.interruptionCheckDelayMs ?? INTERRUPTION_CHECK_DELAY_MS,
        () => notifyUnlessInterrupted(db, job, result, recordedAt, streak, deps));
    } else {
      await notifyIfReportable(db, job, result, recordedAt, streak);
    }
  }

  const [updated] = await db.select().from(cronJobs).where(eq(cronJobs.id, job.id));
  return updated;
}

/**
 * The failure streak after this run: cleared by a success, one longer after
 * the tenant's own failure, and untouched by a run the platform could not
 * start — that says nothing about whether their command works.
 */
function streakAfter(status: CronRunResult['status'], platformFault: string | undefined): SQL | number {
  if (status === 'success') return 0;
  if (platformFault) return sql`${cronJobs.consecutiveFailures}`;
  return sql`${cronJobs.consecutiveFailures} + 1`;
}

/**
 * Tell the tenant about this failure once the streak is long enough for the
 * job's schedule (failure-streak.ts); before that the run record is all there
 * is. Never throws.
 */
async function notifyIfReportable(
  db: Database,
  job: typeof cronJobs.$inferSelect,
  result: CronRunResult,
  recordedAt: Date,
  streak: number,
): Promise<void> {
  try {
    const zone = resolveTimeZone(job, await getPlatformTimeZone(db));
    if (!failureIsReportable(streak, job.schedule, recordedAt, zone)) {
      console.warn(`[cron-scheduler] job ${job.id} failed (${streak} in a row) — reported if its next run fails too`);
      return;
    }
    await notifyFailure(db, job, describeFailure(result, job.type), streak);
  } catch (err) {
    console.warn('[cron-scheduler] failure notification failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * A deployment command that failed because the platform stopped its pod —
 * the server shutting down, the pod being replaced — is not the tenant's
 * failure, and they are not told it is. The run stays recorded as failed,
 * with the reason in front of its output so the panel says what happened.
 * Never throws.
 */
async function notifyUnlessInterrupted(
  db: Database,
  job: typeof cronJobs.$inferSelect,
  result: CronRunResult,
  recordedAt: Date,
  streak: number,
  deps: CronSchedulerDeps,
): Promise<void> {
  try {
    const why = result.ranIn ? await platformInterruption(result.ranIn, deps) : null;
    if (!why) {
      await notifyIfReportable(db, job, result, recordedAt, streak);
      return;
    }
    console.warn(`[cron-scheduler] job ${job.id} was interrupted by the platform (${why}) — not reported as a failure`);
    await db
      .update(cronJobs)
      .set({
        lastRunOutput: clip(`Interrupted by the platform: ${why}. The command itself did not fail.\n${result.output ?? ''}`),
        // Counted as the tenant's failure when it was recorded; it was not. When
        // a later run has already been recorded the guard below skips this, and
        // the streak stays one too high: that errs towards telling the tenant.
        consecutiveFailures: sql`GREATEST(${cronJobs.consecutiveFailures} - 1, 0)`,
      })
      // Only this run's record: a later run has already said something newer.
      .where(and(eq(cronJobs.id, job.id), eq(cronJobs.lastRunAt, recordedAt)));
  } catch (err) {
    console.warn('[cron-scheduler] interruption check failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * The failure notification for one scheduled run: the tenant admins by scope,
 * plus the addresses the job opted into (bounded per job and per tenant per
 * day by failure-email.ts). Never throws — the run record is already written.
 */
async function notifyFailure(
  db: Database,
  job: typeof cronJobs.$inferSelect,
  errorMessage: string,
  streak: number,
): Promise<void> {
  const now = new Date();
  const zone = resolveTimeZone(job, await getPlatformTimeZone(db));
  const email = await resolveFailureEmailRecipients(db, job, now);
  const { notifyTenantScheduledTaskFailure } = await import('../notifications/events.js');
  await notifyTenantScheduledTaskFailure(
    db,
    job.tenantId,
    {
      taskName: job.name,
      errorMessage,
      schedule: `${job.schedule} (${zone})`,
      // Only when it says something: "failed on 1 runs in a row" does not.
      failedRuns: streak > 1 ? String(streak) : null,
    },
    {
      dedupeKey: `scheduled-task-failure:${job.id}:${now.toISOString().slice(0, 10)}`,
      externalRecipients: email.recipients,
      // "Inform the tenant's admins" off: nothing to them on ANY channel —
      // not the tenant's address, not their panel, not their own email.
      informTenantAdmins: job.notifyTenantEmail,
    },
  ).catch((err) => {
    console.warn('[cron-scheduler] failure notification failed:', err instanceof Error ? err.message : err);
  });
}

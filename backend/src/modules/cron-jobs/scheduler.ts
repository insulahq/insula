/**
 * Tenant cron scheduler.
 *
 * Polls every 30s, claims each due job atomically, runs it through
 * `executeCronJob`, and records what happened. Both job types go through the
 * same path — the `type = 'webcron'` filter this loop used to carry is why a
 * deployment cron never fired.
 */

import { and, eq, isNull, lt, ne, or } from 'drizzle-orm';
import { cronJobs } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { executeCronJob, describeFailure, runTimeoutMs, type ClusterTransport } from './executor.js';
import { getNextRunTime } from './cron-expression.js';

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
  options: { readonly notify?: boolean } = {},
): Promise<typeof cronJobs.$inferSelect | undefined> {
  const result = await executeCronJob(db, job, {
    kubeconfigPath: deps.kubeconfigPath,
    timeoutMs: deps.timeoutMs,
    transport: deps.transport,
  });

  await db
    .update(cronJobs)
    .set({
      lastRunAt: new Date(),
      lastRunStatus: result.status,
      lastRunDurationMs: result.durationMs,
      lastRunResponseCode: result.responseCode,
      lastRunOutput: result.output,
    })
    .where(eq(cronJobs.id, job.id));

  // Tell the tenant. Until the notification was added, a failed run recorded
  // itself and notified nobody — a nightly job could fail every night and the
  // only evidence was a column in a panel somebody had to think to open.
  //
  // Dedupe per (job, UTC day): a broken job on a 5-minute schedule would
  // otherwise send 288 notifications before breakfast.
  if (options.notify !== false && result.status === 'failed' && job.tenantId) {
    const { notifyTenantScheduledTaskFailure } = await import('../notifications/events.js');
    await notifyTenantScheduledTaskFailure(
      db,
      job.tenantId,
      { taskName: job.name, errorMessage: describeFailure(result, job.type) },
      `scheduled-task-failure:${job.id}:${new Date().toISOString().slice(0, 10)}`,
    ).catch((err) => {
      console.warn('[cron-scheduler] failure notification failed:', err instanceof Error ? err.message : err);
    });
  }

  const [updated] = await db.select().from(cronJobs).where(eq(cronJobs.id, job.id));
  return updated;
}

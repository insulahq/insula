/**
 * Mail-task orphan reaper.
 *
 * Background: long-running mail tasks (mail.migration, mail.port-exposure)
 * run as background promises inside the platform-api process. When
 * platform-api restarts mid-task (CI deploy, OOM-kill, node drain, etc.),
 * the promise dies but the DB row is left at status='running' forever.
 * Downstream consequences:
 *   - port-exposure: the running-task guard refuses subsequent operator
 *     PATCHes for up to 24h (the global orphan-task reaper threshold).
 *   - migration: the mail_migration_runs row is left at state='running'
 *     and dr-watcher's CAS guard could see stale state.
 *
 * This module marks such mail.migration / mail.port-exposure task rows and
 * mail_migration_runs rows 'failed' with a clear `orphaned-by-startup-reaper`
 * error message. It runs at platform-api start-up and then periodically.
 *
 * "Orphaned" means the owner is GONE, not that the row is old: the process
 * running the task holds a liveness lease per row (task-liveness.ts), and a row
 * is reaped only when its lease is missing or expired. Age alone was the old
 * test — every replica that booted while another replica's migration ran failed
 * that live migration (a deploy; or during a DR failover, the replica the dead
 * node took down, rescheduled while the failover runs). The periodic pass
 * catches an owner that dies after the other replicas booted (a rolling
 * restart's old pod), within the lease TTL.
 *
 * Rows younger than 60 s are never touched (an owner may not have claimed its
 * lease yet); a row that never had a lease waits 10 minutes (see ownerGone);
 * and the advisory lock keeps two replicas from racing each other.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { SCHEDULER_LEASE_KEY_PREFIX } from '../../shared/scheduler-lease.js';
import { mailTaskLeaseName } from './task-liveness.js';

/** platform_settings key prefix of every mail-task liveness lease. */
const LEASE_KEY_PREFIX = `${SCHEDULER_LEASE_KEY_PREFIX}${mailTaskLeaseName('')}`;

/** How often the periodic pass runs (the lease TTL bounds detection on top). */
export const MAIL_TASK_REAPER_INTERVAL_MS = 2 * 60_000;

/**
 * True SQL when the row whose id is `idColumn` (started at `startedColumn`) has
 * no owner any more: its liveness lease has run out (the owner died — reap once
 * the row is a minute old), or it never had one and is over 10 minutes old (a
 * run started by a release without leases during a rolling upgrade, or whose
 * claim failed — its owner may be alive, so it gets a grace period).
 */
function ownerGone(idColumn: 'tasks.id' | 'mail_migration_runs.id', startedColumn: string) {
  const lease = sql`ps.setting_key = ${LEASE_KEY_PREFIX} || ${sql.raw(idColumn)}::text`;
  return sql`(
    NOT EXISTS (
      SELECT 1 FROM platform_settings ps
       WHERE ${lease}
         AND pg_input_is_valid(ps.setting_value, 'jsonb')
         AND pg_input_is_valid(ps.setting_value::jsonb ->> 'until', 'timestamptz')
         AND (ps.setting_value::jsonb ->> 'until')::timestamptz > now()
    )
    AND (
      EXISTS (SELECT 1 FROM platform_settings ps WHERE ${lease})
      OR ${sql.raw(startedColumn)} < NOW() - INTERVAL '10 minutes'
    )
  )`;
}

/**
 * Mark mail-task rows whose owner is gone as 'failed', and drop expired
 * liveness leases. Idempotent. Returns a summary for logging.
 */
export async function reapMailTaskOrphans(db: Database): Promise<{
  tasksReaped: number;
  runsReaped: number;
  leasesDropped: number;
}> {
  const LOCK_KEY = 0x4d41494c; // 'MAIL' as 32-bit int
  const count = (r: { rows?: unknown[]; rowCount?: number }) => r.rowCount ?? r.rows?.length ?? 0;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);

    const tasksResult = await tx.execute(sql`
      UPDATE tasks
         SET status = 'failed',
             finished_at = NOW(),
             error_message = COALESCE(error_message, '') ||
               '[orphaned-by-startup-reaper at ' || NOW()::text ||
               '] platform-api restarted while this task was running; the background promise is gone. Re-trigger the action if you still want it to run.'
       WHERE kind IN ('mail.migration', 'mail.port-exposure')
         AND status = 'running'
         AND started_at < NOW() - INTERVAL '60 seconds'
         AND ${ownerGone('tasks.id', 'tasks.started_at')}
       RETURNING id
    `) as { rows?: unknown[]; rowCount?: number };

    const runsResult = await tx.execute(sql`
      UPDATE mail_migration_runs
         SET state = 'failed',
             finished_at = NOW(),
             error_message = COALESCE(error_message, '') ||
               '[orphaned-by-startup-reaper at ' || NOW()::text ||
               '] platform-api restarted mid-migration; state machine was killed. Re-trigger via /admin/mail/migrate if still wanted.'
       WHERE state IN ('queued','running')
         AND finished_at IS NULL
         AND started_at < NOW() - INTERVAL '60 seconds'
         AND ${ownerGone('mail_migration_runs.id', 'mail_migration_runs.started_at')}
       RETURNING id
    `) as { rows?: unknown[]; rowCount?: number };

    // A finished task releases its lease; a killed owner leaves an expired one.
    const leasesResult = await tx.execute(sql`
      DELETE FROM platform_settings
       WHERE setting_key LIKE ${`${LEASE_KEY_PREFIX}%`}
         AND NOT (
           pg_input_is_valid(setting_value, 'jsonb')
           AND pg_input_is_valid(setting_value::jsonb ->> 'until', 'timestamptz')
           AND (setting_value::jsonb ->> 'until')::timestamptz > now()
         )
       RETURNING setting_key
    `) as { rows?: unknown[]; rowCount?: number };

    return {
      tasksReaped: count(tasksResult),
      runsReaped: count(runsResult),
      leasesDropped: count(leasesResult),
    };
  });
}

/**
 * Mail-task orphan reaper (2026-05-28).
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
 * This module runs once at platform-api startup. It marks any
 * mail.migration / mail.port-exposure task in status='running' as
 * 'failed' with a clear `orphaned-by-startup` error message. Symmetric
 * cleanup for mail_migration_runs: rows in transient states
 * ('running','snapshotting','restoring','scaling-up','swapping-pvc')
 * with no finished_at get state='failed'.
 *
 * The global tasks orphan reaper (tasks/service.ts) has a 24h floor —
 * appropriate for low-frequency one-shot tasks. Mail tasks are
 * higher-frequency and operator-blocking (an orphan port-exposure task
 * blocks the next mode switch indefinitely), so the boot-time sweep
 * recovers faster.
 *
 * Safe to call at every boot: only touches rows whose started_at is
 * older than 60s (so a genuinely-in-flight task in another live
 * platform-api replica is not stomped).
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';

/**
 * Mark stale 'running' mail-task rows as 'failed'. Idempotent. Returns
 * a summary for logging.
 */
export async function reapMailTaskOrphansOnBoot(db: Database): Promise<{
  tasksReaped: number;
  runsReaped: number;
}> {
  // 60s threshold: any mail task started > 60s ago that's still
  // 'running' is either (a) a genuine cross-replica in-flight task
  // on another platform-api pod, OR (b) an orphan whose owning pod
  // is gone. We treat (a) as the safe minority — the worst case is
  // we falsely-fail a still-active task once per boot, which the
  // operator can retry. The common case is (b), which currently
  // blocks the next operator action for 24h.
  //
  // pg_advisory_lock keeps two replicas booting simultaneously from
  // racing each other's UPDATE.
  const LOCK_KEY = 0x4d41494c; // 'MAIL' as 32-bit int
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
       RETURNING id
    `) as { rows?: unknown[]; rowCount?: number };

    const runsResult = await tx.execute(sql`
      UPDATE mail_migration_runs
         SET state = 'failed',
             finished_at = NOW(),
             error_message = COALESCE(error_message, '') ||
               '[orphaned-by-startup-reaper at ' || NOW()::text ||
               '] platform-api restarted mid-migration; state machine was killed. Re-trigger via /admin/mail/migrate if still wanted.'
       WHERE state IN ('running','snapshotting','restoring','scaling-up','swapping-pvc','preflight','verifying')
         AND finished_at IS NULL
         AND started_at < NOW() - INTERVAL '60 seconds'
       RETURNING id
    `) as { rows?: unknown[]; rowCount?: number };

    return {
      tasksReaped: tasksResult.rowCount ?? tasksResult.rows?.length ?? 0,
      runsReaped: runsResult.rowCount ?? runsResult.rows?.length ?? 0,
    };
  });
}

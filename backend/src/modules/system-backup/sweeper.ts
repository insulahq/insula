/**
 * System Backup sweeper — Phase 2.4c.
 *
 * Two responsibilities, one tick:
 *
 *   1. Orphan pending: any system_backup_runs row stuck in
 *      status='pending' for &gt;10 minutes is flipped to 'failed' with
 *      code SYSTEM_BACKUP_JOB_ORPHANED. The risk window is sub-second
 *      between route INSERT and createPgDumpJob — but a SIGKILLed
 *      platform-api leaves the row pending forever otherwise.
 *
 *   2. Retention: pg_dump runs older than RETENTION_DAYS in
 *      status='failed' are deleted (rows only — the BackupStore
 *      bundle was already cleaned by the orchestrator's catch-path
 *      delete()). 'succeeded' rows are KEPT — operators may still
 *      need the bundleId/sha256 to locate an artifact at the store.
 *      Phase 1 'secrets' rows are NEVER touched here — their cleanup
 *      is download-driven (claim-on-download) and they may be valuable
 *      audit history regardless of age.
 *
 * Tick interval: 5 min. Best-effort — failures log + continue.
 */

import { and, eq, lt, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { systemBackupRuns } from '../../db/schema.js';

const TICK_INTERVAL_MS = 5 * 60 * 1000;
const ORPHAN_PENDING_AGE_MS = 10 * 60 * 1000;
// A pg-dump Job is created with `activeDeadlineSeconds: 5400` (90 min) and
// `backoffLimit: 0` (pg-dump-job-spawner.ts), so its pod cannot run longer
// than 90 min before k8s SIGKILLs it. A run still in 'running' past that
// (+ the ≤10-min pending window + a grace margin) is therefore orphaned:
// the Job died WITHOUT the orchestrator writing a terminal status (k8s
// killed the process on deadline/OOM, so the catch-path never ran). Flip
// it to 'failed' so pollers and the operator UI don't hang on it. (#128)
const ORPHAN_RUNNING_AGE_MS = 110 * 60 * 1000;
const RETENTION_DAYS = 90;

interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface SweepResult {
  readonly orphanedPending: number;
  readonly orphanedRunning: number;
  readonly purgedFailed: number;
}

/** One sweep tick. Exported for unit tests. */
export async function runSystemBackupSweeperTick(db: Database): Promise<SweepResult> {
  const orphanCutoff = new Date(Date.now() - ORPHAN_PENDING_AGE_MS);
  const runningCutoff = new Date(Date.now() - ORPHAN_RUNNING_AGE_MS);
  const retentionCutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // Orphan flip — covers BOTH 'secrets' and 'pg_dump' kinds; the
  // failure mode (SIGKILL between INSERT and Job spawn) applies to
  // both subsystems.
  const orphaned = await db
    .update(systemBackupRuns)
    .set({
      status: 'failed',
      finishedAt: new Date(),
      errorEnvelope: {
        code: 'SYSTEM_BACKUP_JOB_ORPHANED',
        message: 'run row stuck in pending — sweeper flipped to failed (Job spawn likely never happened)',
      } as unknown as Record<string, unknown>,
    })
    .where(and(
      eq(systemBackupRuns.status, 'pending'),
      lt(systemBackupRuns.createdAt, orphanCutoff),
    ))
    .returning({ id: systemBackupRuns.id });

  // Orphan flip #2 — a run stuck in 'running' past the Job's hard
  // activeDeadlineSeconds (+ pending window + grace) is one whose Job
  // died WITHOUT reporting a terminal status (k8s SIGKILLed the pod on
  // deadline/OOM, so the orchestrator's catch never wrote 'failed').
  // Without this, the row would show 'running' forever and any poller
  // (the integration harness, the operator UI) hangs on it. (#128)
  const orphanedRunning = await db
    .update(systemBackupRuns)
    .set({
      status: 'failed',
      finishedAt: new Date(),
      errorEnvelope: {
        code: 'SYSTEM_BACKUP_JOB_ORPHANED',
        message: 'run row stuck in running past the Job activeDeadlineSeconds — sweeper flipped to failed (Job died without reporting a terminal status)',
      } as unknown as Record<string, unknown>,
    })
    .where(and(
      eq(systemBackupRuns.status, 'running'),
      lt(systemBackupRuns.createdAt, runningCutoff),
    ))
    .returning({ id: systemBackupRuns.id });

  // Retention purge — pg_dump only. 'secrets' rows are kept indefinitely
  // (small, audit-relevant). Use raw SQL for the DELETE…RETURNING to
  // get a count without a separate SELECT.
  const purged = await db.execute(sql`
    DELETE FROM ${systemBackupRuns}
    WHERE kind = 'pg_dump'
      AND status = 'failed'
      AND created_at < ${retentionCutoff}
    RETURNING id
  `);
  // pg's `.execute` returns { rows, rowCount }. Count failed deletes
  // off rowCount; the cast keeps the Drizzle types happy.
  const purgedCount = (purged as unknown as { rowCount?: number }).rowCount ?? 0;

  return {
    orphanedPending: orphaned.length,
    orphanedRunning: orphanedRunning.length,
    purgedFailed: purgedCount,
  };
}

/**
 * Start the sweeper. Self-rescheduling setTimeout chain so a single
 * `clearTimeout` stops it at shutdown.
 */
export function startSystemBackupSweeper(db: Database, logger: Logger): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const r = await runSystemBackupSweeperTick(db);
      if (r.orphanedPending > 0 || r.orphanedRunning > 0 || r.purgedFailed > 0) {
        logger.info(
          { orphanedPending: r.orphanedPending, orphanedRunning: r.orphanedRunning, purgedFailed: r.purgedFailed },
          '[system-backup-sweeper] tick',
        );
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[system-backup-sweeper] tick failed',
      );
    }
    if (!stopped) timer = setTimeout(tick, TICK_INTERVAL_MS);
  };

  timer = setTimeout(tick, TICK_INTERVAL_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

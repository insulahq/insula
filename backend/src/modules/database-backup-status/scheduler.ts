/**
 * Runs the stale-backup sweep (sweep.ts) on one replica.
 *
 * 15 minutes is far inside the threshold (26 h for a daily schedule), so an
 * episode is announced within a quarter of an hour of the backup becoming
 * overdue, and a recovery within a quarter of an hour of the next good dump.
 */

import type { Database } from '../../db/index.js';
import { safeTick } from '../../shared/safe-tick.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import { runDatabaseBackupSweep } from './sweep.js';

export const DATABASE_BACKUP_SWEEP_TICK_MS = 15 * 60 * 1000;

export function startDatabaseBackupStatusScheduler(
  db: Database,
  opts: { readonly tickMs?: number } = {},
): () => void {
  const tickMs = opts.tickMs ?? DATABASE_BACKUP_SWEEP_TICK_MS;
  const log = {
    warn: (msg: string, err?: unknown) => console.warn(`[database-backup-status] ${msg}`, err ?? ''),
  };
  // Episodes are opened and alerted by a read-then-write; two replicas
  // sweeping together would each announce them.
  const tick = (): void => safeTick(
    'database-backup-status',
    () => withSchedulerLease(db, 'database-backup-status', tickMs * 1.5, () => runDatabaseBackupSweep(db)),
    log,
  );
  tick();
  const timer = setInterval(tick, tickMs);
  return () => clearInterval(timer);
}

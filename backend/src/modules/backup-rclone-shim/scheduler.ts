/**
 * backup-rclone-shim periodic reconciler.
 *
 * Mirrors `startWebmailFeatureCssReconciler`'s pattern:
 *   - Boots immediately via `setImmediate(tick)` so cold-start
 *     convergence shares the same code path as the periodic tick.
 *   - Runs every 5 minutes (`unref()`'d timer so process exit isn't
 *     blocked).
 *   - Errors caught at the boundary; never throws into the
 *     interval-runner.
 *
 * Idempotent: when `inputHash` is unchanged the reconciler refreshes
 * the status ConfigMap's `reconciledAt` and bails before any
 * ConfigMap / Secret / DaemonSet write.
 *
 * A target change (apply-assignment.ts) also reconciles at once instead of
 * waiting for the tick. Both take the job's run lock (shared/exclusive-run.ts),
 * so the two never render at the same time.
 */
import { runExclusive } from '../../shared/exclusive-run.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import type { Logger } from 'pino';

import type { Database } from '../../db/index.js';
import {
  reconcileBackupRcloneShim,
  type ShimReconcileClients,
} from './reconciler.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface BackupRcloneShimSchedulerHandle {
  readonly stop: () => void;
}

export interface BackupRcloneShimSchedulerOpts {
  readonly intervalMs?: number;
}

export function startBackupRcloneShimReconciler(
  db: Database,
  clients: ShimReconcileClients,
  encryptionKey: string,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  opts: BackupRcloneShimSchedulerOpts = {},
): BackupRcloneShimSchedulerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let cancelled = false;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    try {
      // One replica ticks: an SFTP-password or CIFS target is obscured with a
      // random IV, so two replicas rendering the same change stamp different
      // config hashes on the shim DaemonSet and roll it twice. The run lock
      // keeps this tick off a reconcile a target change has started.
      await withSchedulerLease(db, 'backup-rclone-shim', intervalMs * 1.5,
        () => runExclusive(db, 'backup-rclone-shim', () => reconcileBackupRcloneShim(db, clients, encryptionKey, log), { log }), { log });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'backup-rclone-shim-scheduler: tick threw',
      );
    }
  };

  setImmediate(tick);

  const timer = setInterval(tick, intervalMs);
  timer.unref();

  log.info(
    { intervalMs },
    'backup-rclone-shim-scheduler: started',
  );

  return {
    stop: () => {
      cancelled = true;
      clearInterval(timer);
    },
  };
}

// Re-export the reconciler clients type so callers don't need to
// reach into reconciler.ts.
export type { ShimReconcileClients } from './reconciler.js';

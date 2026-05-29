/**
 * stalwart-snapshot CronJob reconciler scheduler.
 *
 * Same shape as backup-rclone-shim/etcd-cronjob-scheduler.ts: a 5-minute
 * tick + setImmediate cold-start kick. The cold-start kick is load-bearing
 * on a FRESH bootstrap — it claims SSA ownership of spec.schedule early so
 * the Flux schedule-strip leaves a valid value and the `platform`
 * Kustomization reaches Ready.
 */

import type { Logger } from 'pino';

import type { Database } from '../../db/index.js';
import {
  reconcileMailSnapshotCronJob,
  type MailSnapshotCronJobClients,
} from './snapshot-cronjob-reconciler.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface MailSnapshotCronJobSchedulerHandle {
  readonly stop: () => void;
}

export function startMailSnapshotCronJobReconciler(
  db: Database,
  clients: MailSnapshotCronJobClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  opts: { intervalMs?: number } = {},
): MailSnapshotCronJobSchedulerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let cancelled = false;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    try {
      await reconcileMailSnapshotCronJob(db, clients, log);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'mail-snapshot-cronjob-scheduler: tick threw',
      );
    }
  };

  setImmediate(tick);
  const timer = setInterval(tick, intervalMs);
  timer.unref();

  log.info({ intervalMs }, 'mail-snapshot-cronjob-scheduler: started');

  return {
    stop: () => {
      cancelled = true;
      clearInterval(timer);
    },
  };
}

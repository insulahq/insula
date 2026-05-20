/**
 * etcd-cronjob reconciler scheduler (R-X7).
 *
 * Same shape as postgres-objectstore-scheduler.ts. 5-minute tick
 * + setImmediate cold-start kick.
 */

import type { Logger } from 'pino';

import type { Database } from '../../db/index.js';
import {
  reconcileEtcdCronJob,
  type EtcdCronJobClients,
} from './etcd-cronjob.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface EtcdCronJobSchedulerHandle {
  readonly stop: () => void;
}

export function startEtcdCronJobReconciler(
  db: Database,
  clients: EtcdCronJobClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  opts: { intervalMs?: number } = {},
): EtcdCronJobSchedulerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let cancelled = false;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    try {
      await reconcileEtcdCronJob(db, clients, log);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'etcd-cronjob-scheduler: tick threw',
      );
    }
  };

  setImmediate(tick);
  const timer = setInterval(tick, intervalMs);
  timer.unref();

  log.info({ intervalMs }, 'etcd-cronjob-scheduler: started');

  return {
    stop: () => {
      cancelled = true;
      clearInterval(timer);
    },
  };
}

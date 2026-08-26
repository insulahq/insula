/**
 * DR-CronJob bridge scheduler.
 *
 * Same shape as etcd-cronjob-scheduler.ts: 5-minute tick + setImmediate
 * cold-start kick. See dr-cronjobs.ts for what a tick does.
 */

import type { Logger } from 'pino';

import type { Database } from '../../db/index.js';
import { reconcileDrCronJobs } from './dr-cronjobs.js';
import type * as k8s from '@kubernetes/client-node';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface DrCronJobsSchedulerHandle {
  readonly stop: () => void;
}

export interface DrCronJobsClients {
  readonly core: k8s.CoreV1Api;
  readonly batch: k8s.BatchV1Api;
  readonly custom: k8s.CustomObjectsApi;
}

export function startDrCronJobsReconciler(
  db: Database,
  clients: DrCronJobsClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  opts: { intervalMs?: number } = {},
): DrCronJobsSchedulerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let cancelled = false;
  let lastState = '';

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    try {
      const r = await reconcileDrCronJobs(db, clients, log);
      // Log on state changes and on any write, not every quiet tick.
      if (r.state !== lastState || r.unsuspended > 0 || r.suspended > 0) {
        log.info({ ...r }, 'dr-cronjobs-scheduler: reconciled');
        lastState = r.state;
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'dr-cronjobs-scheduler: tick threw',
      );
    }
  };

  setImmediate(tick);
  const timer = setInterval(tick, intervalMs);
  timer.unref();

  log.info({ intervalMs }, 'dr-cronjobs-scheduler: started');

  return {
    stop: () => {
      cancelled = true;
      clearInterval(timer);
    },
  };
}

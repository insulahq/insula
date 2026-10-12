/**
 * cluster-trusted-proxies periodic reconciler.
 *
 * 5-min tick (`unref()`'d timer) that re-converges:
 *   - DB rows (operator + bootstrap)
 *   - ConfigMap `platform/cluster-trusted-proxies`
 *   - Traefik DS args
 *   - admin-panel + tenant-panel pod-template hash annotation
 *
 * The POST / DELETE routes also fire an inline reconcile (not awaited)
 * for instant convergence. The scheduler picks up any failed inline
 * runs on the next tick.
 */
import { runExclusive, type ExclusiveRunOptions } from '../../shared/exclusive-run.js';
import { withSchedulerLease, type LeaseOutcome } from '../../shared/scheduler-lease.js';
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import type { Database } from '../../db/index.js';
import {
  reconcileClusterTrustedProxies,
  type ReconcileClients,
} from './reconciler.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface SchedulerHandle {
  readonly stop: () => void;
}

export interface SchedulerClients {
  readonly core: k8s.CoreV1Api;
  readonly apps: k8s.AppsV1Api;
}

/**
 * The one way to reconcile, for the tick and for the routes. The reconciler
 * reads the Traefik DS args and JSON-patches them by index: two runs at once
 * each compute indices from the same snapshot, and the second patch lands on
 * stale positions if the first appended arguments. The run lock holds across
 * replicas and within one process.
 *
 * A caller that has just changed the ranges passes `waitMs`: its run then
 * starts after the one under way has finished, so it reads the change. (It
 * used to be handed the run already under way, which may have read the ranges
 * before the change — leaving it to the next tick.)
 */
export function runReconcileExclusive(
  db: Database,
  clients: ReconcileClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  opts: ExclusiveRunOptions = {},
): Promise<LeaseOutcome<unknown>> {
  return runExclusive(db, 'cluster-trusted-proxies', () => reconcileClusterTrustedProxies(db, clients, log), { log, ...opts });
}

export function startClusterTrustedProxiesReconciler(
  db: Database,
  clients: SchedulerClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): SchedulerHandle {
  let cancelled = false;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    try {
      const reconcileClients: ReconcileClients = {
        core: clients.core,
        apps: clients.apps,
      };
      // One replica ticks; the run lock inside keeps the tick off a reconcile
      // a route has started, here or on another replica.
      await withSchedulerLease(db, 'cluster-trusted-proxies', intervalMs * 1.5,
        () => runReconcileExclusive(db, reconcileClients, log), { log });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'cluster-trusted-proxies-scheduler: tick threw',
      );
    }
  };

  setImmediate(tick);

  const timer = setInterval(tick, intervalMs);
  timer.unref();

  log.info(
    { intervalMs },
    'cluster-trusted-proxies-scheduler: started',
  );

  return {
    stop: () => {
      cancelled = true;
      clearInterval(timer);
    },
  };
}

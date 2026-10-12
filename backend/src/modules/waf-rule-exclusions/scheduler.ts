/**
 * waf-rule-exclusions periodic reconciler.
 *
 * Mirrors `startWebmailFeatureCssReconciler`'s pattern. Runs every 5
 * minutes (`unref()`'d timer) to recover from drift between the DB and
 * the in-cluster ConfigMap + Deployment annotation:
 *  - Manual `kubectl edit configmap modsec-crs-exclusions-dynamic`
 *  - Flux re-apply of the empty seed ConfigMap
 *  - A new operator action that hasn't triggered the inline reconcile
 *    (e.g. multiple PATCHes in quick succession where one tick happens
 *    to land mid-transaction)
 *
 * The routes.ts handlers ALSO trigger an inline reconcile after every
 * mutation so the operator sees the change reflect within seconds.
 */

import { runExclusive, type ExclusiveRunOptions } from '../../shared/exclusive-run.js';
import { withSchedulerLease, type LeaseOutcome } from '../../shared/scheduler-lease.js';
import type { Logger } from 'pino';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { reconcileWafExclusions, type ReconcileResult, type WafExclusionClients } from './reconciler.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = NodePgDatabase<any>;

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface WafExclusionSchedulerHandle {
  readonly stop: () => void;
}

/**
 * The one way to reconcile, for the tick and for the routes that change an
 * exclusion. Two runs at once can each stamp a hash on the WAF deployment and
 * roll it twice; the run lock holds across replicas and within one process. A
 * caller that has just changed an exclusion passes `waitMs`, so its run starts
 * after the one under way and reads the change.
 */
export function runWafExclusionReconcile(
  db: Db,
  clients: WafExclusionClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  opts: ExclusiveRunOptions = {},
): Promise<LeaseOutcome<ReconcileResult>> {
  return runExclusive(db, 'waf-rule-exclusions', () => reconcileWafExclusions(db, clients, log), { log, ...opts });
}

export function startWafExclusionReconciler(
  db: Db,
  clients: WafExclusionClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): WafExclusionSchedulerHandle {
  let cancelled = false;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    try {
      // One replica renders: the bypass list comes from an exec that fails
      // closed to an empty list, so a replica whose exec failed stamps a
      // different hash than one whose exec worked, and each rolls the WAF.
      await withSchedulerLease(db, 'waf-rule-exclusions', intervalMs * 1.5,
        () => runWafExclusionReconcile(db, clients, log), { log });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'waf-rule-exclusions-scheduler: tick threw',
      );
    }
  };

  // Fire immediately so cold-start convergence shares the same code
  // path as the periodic tick.
  setImmediate(tick);

  const timer = setInterval(tick, intervalMs);
  timer.unref();

  log.info({ intervalMs }, 'waf-rule-exclusions-scheduler: started');

  return {
    stop: () => {
      cancelled = true;
      clearInterval(timer);
    },
  };
}

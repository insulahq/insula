/**
 * Ticker for the DR cadence reconciler + firing engine.
 *
 * Two independent cadences, matching the convention the mail-snapshot
 * scheduler already established:
 *
 *   reconcile (5 min)  converge suspend/schedule from `backup_schedules` onto
 *                      the live objects. Slow is fine: nothing about it is
 *                      time-critical, and an operator edit triggers it
 *                      immediately through `reconcileNow`.
 *   fire      (30 s)   for platform-fired targets, check whether the operator
 *                      cron matches a minute inside the catch-up window and
 *                      create the Job if so. Faster than a minute so a tick
 *                      never straddles the matching minute and misses it.
 *
 * The catch-up window means an API restart of up to 5 minutes still fires a
 * schedule it slept through; longer outages skip it, which is what the k8s
 * CronJob controller does by default too.
 */

import type { Logger } from 'pino';

import type { Database } from '../../../db/index.js';
import { reconcileAllCadence, resolveFiringPlan, type CadenceClients, type CadenceOutcome } from './reconciler.js';
import { fireIfDue, type FiringClients } from './firing.js';
import { resolvePlatformTimeZone } from '../../system-settings/platform-timezone.js';

const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const FIRE_INTERVAL_MS = 30 * 1000;
const CATCH_UP_WINDOW_MS = 5 * 60 * 1000;

export interface CadenceSchedulerHandle {
  readonly stop: () => void;
  /** Run a reconcile immediately — called after an operator edits a schedule. */
  readonly reconcileNow: () => Promise<readonly CadenceOutcome[]>;
}

export interface CadenceSchedulerDeps {
  readonly db: Database;
  readonly clients: CadenceClients & FiringClients;
  readonly log: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Test seam. */
  readonly now?: () => Date;
}

/**
 * Minutes inside the catch-up window, newest first, so the most recent match
 * wins and older ones are only considered when the newest is already fired.
 */
function windowMinutes(now: Date): Date[] {
  const out: Date[] = [];
  const startMs = Math.floor(now.getTime() / 60_000) * 60_000;
  for (let ms = startMs; ms > startMs - CATCH_UP_WINDOW_MS; ms -= 60_000) {
    out.push(new Date(ms));
  }
  return out;
}

export function startCadenceScheduler(deps: CadenceSchedulerDeps): CadenceSchedulerHandle {
  const { db, clients, log } = deps;
  const now = deps.now ?? (() => new Date());

  /** Latest reconcile result, so the firing tick knows who is platform-fired. */
  let lastOutcomes: readonly CadenceOutcome[] = [];

  const runReconcile = async (): Promise<readonly CadenceOutcome[]> => {
    try {
      lastOutcomes = await reconcileAllCadence(db, clients, log);
    } catch (err) {
      // reconcileAllCadence already swallows per-target failures; this catches
      // only a failure of the sweep itself (a DB outage, say). A scheduler tick
      // must never terminate the API.
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'cadence: reconcile sweep failed');
    }
    return lastOutcomes;
  };

  const runFiring = async (): Promise<void> => {
    // The plan is read from the database on EVERY tick rather than taken from
    // the last reconcile. `lastOutcomes` is per-process: in HA mode the other
    // replicas would go on firing a cron the operator had already changed, or
    // one they had switched off, until their own 5-minute tick. The schedule
    // that decides whether a backup runs is not a good place for cached state.
    let plan: ReadonlyArray<{ target: { namespace: string; name: string; subsystem: string }; cron: string }>;
    try {
      plan = await resolveFiringPlan(db, log);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'cadence: could not read the firing plan');
      return;
    }
    // Resolved once per tick, not per target: getSettings is cached, but the
    // zone must also be identical across every target in one sweep.
    const zone = await resolvePlatformTimeZone(db, log);
    for (const { target, cron } of plan) {
      for (const minute of windowMinutes(now())) {
        const res = await fireIfDue(
          clients,
          { namespace: target.namespace, cronJobName: target.name, cron, at: minute, zone },
          log,
        );
        // Stop at the first minute that matched — whether we created the Job
        // or found it already there. Continuing would fire older minutes in
        // the window on every tick.
        if (res.fired || res.duplicate) break;
      }
    }
  };

  const reconcileTimer = setInterval(() => { void runReconcile(); }, RECONCILE_INTERVAL_MS);
  const fireTimer = setInterval(() => { void runFiring(); }, FIRE_INTERVAL_MS);
  // Cold-start kick: converge before the first interval elapses, so a fresh
  // pod does not leave an operator's cadence unapplied for five minutes.
  setImmediate(() => { void runReconcile(); });

  return {
    stop: () => { clearInterval(reconcileTimer); clearInterval(fireTimer); },
    reconcileNow: runReconcile,
  };
}

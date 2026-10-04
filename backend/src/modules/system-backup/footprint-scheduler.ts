import type * as k8s from '@kubernetes/client-node';
import type { Database } from '../../db/index.js';
import { safeTick } from '../../shared/safe-tick.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import { measureSystemFootprint } from './footprint-measure.js';
import { clearSystemFootprint, storeSystemFootprint, systemClassIsBound } from './footprint-store.js';

/**
 * Hourly measurement of what the SYSTEM backup class stores at its target, for
 * the dashboard's Backups & DR card. One replica measures (lease); the figure
 * is shared through platform_settings.
 */
const INTERVAL_MS = 60 * 60_000;
const INITIAL_DELAY_MS = 3 * 60_000;

export function startSystemFootprintScheduler(deps: {
  readonly db: Database;
  readonly core: k8s.CoreV1Api;
  readonly custom: k8s.CustomObjectsApi;
  readonly log: { warn: (msg: string, err?: unknown) => void };
}): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const outcome = await withSchedulerLease(deps.db, 'system-backup-footprint', INTERVAL_MS * 1.5, async () => {
      // No system target: nothing to measure, and a size measured at a target
      // since unassigned must not stay on the card.
      if (!(await systemClassIsBound(deps.db))) {
        await clearSystemFootprint(deps.db);
        return { error: null };
      }
      const footprint = await measureSystemFootprint(deps.db, deps);
      await storeSystemFootprint(deps.db, footprint);
      return footprint;
    });
    if (outcome.ran && outcome.value.error) deps.log.warn(`[system-backup-footprint] ${outcome.value.error}`);
  };

  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      safeTick('system-backup-footprint', tick, deps.log);
      schedule(INTERVAL_MS);
    }, delay);
  };
  schedule(INITIAL_DELAY_MS);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

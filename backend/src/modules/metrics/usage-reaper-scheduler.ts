/**
 * Phase 2 — daily usage-metrics reaper.
 *
 * Folds hourly rollup rows older than 30d into daily rows (kept 1y) and purges,
 * keeping usage_metrics bounded. Single in-process daily timer; runs 5 min after
 * boot (past startup migrations) then every 24h. stop() on app close.
 */

import { reapUsageMetrics } from './usage-rollup.js';
import type { Database } from '../../db/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 60 * 1000;

export function startUsageReaper(db: Database): NodeJS.Timeout {
  const run = async () => {
    try {
      await reapUsageMetrics(db);
      console.log('[usage-reaper] rollup fold + purge complete');
    } catch (err) {
      console.error('[usage-reaper] reap failed:', err instanceof Error ? err.message : String(err));
    }
  };
  setTimeout(run, INITIAL_DELAY_MS);
  return setInterval(run, DAY_MS);
}

/**
 * Daily rollup reaper.
 *
 * Folds hourly usage_metrics and traffic rollup rows older than 30d into
 * daily rows, daily rows older than a year into monthly rows (kept 5y), and
 * purges — keeping both stores bounded. Single daily timer; runs 5 min after
 * boot (past startup migrations) then every 24h. stop() on app close.
 *
 * One replica reaps (a lease): the folds are INSERT … ON CONFLICT over a
 * GROUP BY, and three replicas running them at once take the same row locks
 * in different orders — a deadlock that cost the day's fold.
 */

import { reapUsageMetrics } from './usage-rollup.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import type { Database } from '../../db/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 60 * 1000;

export function startUsageReaper(db: Database): NodeJS.Timeout {
  const run = async () => {
    try {
      const leased = await withSchedulerLease(db, 'usage-reaper', DAY_MS * 1.5, () => reapUsageMetrics(db));
      if (leased.ran) console.log('[usage-reaper] rollup fold + purge complete');
    } catch (err) {
      console.error('[usage-reaper] reap failed:', err instanceof Error ? err.message : String(err));
    }
  };
  setTimeout(run, INITIAL_DELAY_MS);
  return setInterval(run, DAY_MS);
}

/**
 * Notification-retention cron.
 *
 * Mirrors modules/data-retention/scheduler.ts: run once at startup, then
 * every 6 hours.
 *
 * The startup run is the whole point. This pass used to be a bare
 * `setInterval(…, 24h)` registered in app.ts with no immediate call, so it
 * only ever fired on a process that stayed up a full day. Measured
 * 2026-09-10: the DEV cluster re-pins images on every push to
 * `development` and rolls platform-api with it — eleven ReplicaSets in the
 * preceding 20 hours, longest gap 9h28m — so the tick was skipped
 * indefinitely there while staging, which only rolls on a release, was
 * pruning normally. Retention that silently depends on deploy cadence is
 * retention you cannot reason about; running at startup removes the
 * dependency entirely.
 */
import { runNotificationRetention } from './purge.js';
import { safeTick } from '../../../shared/safe-tick.js';
import type { Database } from '../../../db/index.js';

const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export function startNotificationRetention(db: Database): NodeJS.Timeout {
  safeTick('notification-retention', () => runOnce(db));
  const timer = setInterval(() => {
    safeTick('notification-retention', () => runOnce(db));
  }, RETENTION_INTERVAL_MS);
  // Don't hold the event loop open during shutdown — the onClose hook
  // clears the interval anyway, but unref() is belt-and-braces.
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

async function runOnce(db: Database): Promise<void> {
  const r = await runNotificationRetention(db);
  // Sum every counter — a table missing from this total is a table whose
  // pruning is invisible in the logs, which is how the notifications gap
  // survived three months of "notifications are pruned too" in a comment.
  const total = r.deliveries + r.notifications + r.buckets;
  if (total > 0) {
    const parts = Object.entries({
      notification_deliveries: r.deliveries,
      notifications: r.notifications,
      notification_rate_limit_buckets: r.buckets,
    }).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
    console.log(`[notification-retention] pruned ${parts.join(' · ')}`);
  }
}

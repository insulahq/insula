/**
 * Notification retention.
 *
 * Two tables, two windows, one pass:
 *
 *   - `notification_deliveries` (30d) — the per-recipient delivery audit
 *     trail. High volume; one row per recipient per channel.
 *   - `notifications` (90d) — the in-app inbox rows admins and tenants
 *     read in the panel.
 *
 * The inbox table used to have NO age retention at all, on the reasoning
 * that its rows are "user-deletable". They are — one at a time, via
 * `DELETE /notifications/:id`; there is no bulk delete in either panel and
 * nobody prunes an inbox by hand. Measured on staging 2026-09-10: 2685
 * rows going back to the day the cluster was first migrated, 2619 of them
 * older than 30 days, none ever reaped. That is monotonic growth with no
 * ceiling, so the window below now applies to both tables.
 *
 * Age, not read-state. Keeping unread rows forever would reintroduce
 * exactly the unbounded growth this exists to stop — users do not read
 * everything, and a 90-day-old unread notification is not actionable.
 * Anything that genuinely needs to outlive the window is delivered
 * out-of-band too (email / ntfy) and recorded in `audit_logs`, which has
 * its own 180-day retention.
 *
 * Ordering note: `notification_deliveries.notification_id` carries an FK to
 * `notifications(id) ON DELETE CASCADE`, so purging a notification also
 * removes any straggler delivery rows that reference it. The two windows
 * must therefore stay ordered — see the test that pins
 * NOTIFICATION_RETENTION_DAYS > DELIVERY_RETENTION_DAYS.
 *
 * Scheduling lives in ./scheduler.ts — run once at startup, then every 6h.
 */
import { lt } from 'drizzle-orm';
import { notifications, notificationDeliveries } from '../../../db/schema.js';
import { purgeStaleBuckets } from '../rate-limit/service.js';
import type { Database } from '../../../db/index.js';

/** Per-recipient delivery audit trail. High volume, short window. */
export const DELIVERY_RETENTION_DAYS = 30;

/**
 * In-app inbox rows. Deliberately wider than the delivery window so the
 * ON DELETE CASCADE from deliveries → notifications never truncates the
 * delivery audit trail early.
 */
export const NOTIFICATION_RETENTION_DAYS = 90;

function cutoffFor(retentionDays: number, now: Date): Date {
  return new Date(now.getTime() - retentionDays * 24 * 3600 * 1000);
}

export async function purgeOldDeliveries(
  db: Database,
  retentionDays = DELIVERY_RETENTION_DAYS,
  now: Date = new Date(),
): Promise<number> {
  if (retentionDays <= 0) return 0;
  const result = await db
    .delete(notificationDeliveries)
    .where(lt(notificationDeliveries.queuedAt, cutoffFor(retentionDays, now)))
    .returning({ id: notificationDeliveries.id });
  return result.length;
}

export async function purgeOldNotifications(
  db: Database,
  retentionDays = NOTIFICATION_RETENTION_DAYS,
  now: Date = new Date(),
): Promise<number> {
  if (retentionDays <= 0) return 0;
  const result = await db
    .delete(notifications)
    .where(lt(notifications.createdAt, cutoffFor(retentionDays, now)))
    .returning({ id: notifications.id });
  return result.length;
}

export interface NotificationRetentionResult {
  readonly deliveries: number;
  readonly notifications: number;
  readonly buckets: number;
}

interface RunOptions {
  /** Seam for tests; defaults to the real rate-limit bucket purge. */
  readonly purgeBuckets?: (db: Database) => Promise<number>;
}

async function count(label: string, fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[notifications] ${label} purge failed:`, err instanceof Error ? err.message : err);
    return 0;
  }
}

/**
 * One retention pass. Each table is guarded independently — a lock or
 * error on one must not skip the others, which is how the table that
 * actually grows unbounded would end up being the one never pruned.
 *
 * Never throws: the caller is a scheduler tick.
 */
export async function runNotificationRetention(
  db: Database,
  options: RunOptions = {},
): Promise<NotificationRetentionResult> {
  const buckets = options.purgeBuckets ?? purgeStaleBuckets;
  return {
    deliveries: await count('deliveries', () => purgeOldDeliveries(db)),
    notifications: await count('notifications', () => purgeOldNotifications(db)),
    buckets: await count('rate-limit buckets', () => buckets(db)),
  };
}

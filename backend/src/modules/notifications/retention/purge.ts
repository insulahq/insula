/**
 * Notification retention.
 *
 * Four tables, one pass. NOTHING in the notification domain may grow
 * without a ceiling, and no window may exceed MAX_RETENTION_DAYS (90):
 *
 *   - `notification_deliveries` (30d) — the per-recipient delivery audit
 *     trail. High volume; one row per recipient per channel.
 *   - `notifications` (90d) — the in-app inbox rows admins and tenants
 *     read in the panel.
 *   - `notification_rate_limit_buckets` (window_end < now) — counters.
 *   - `notification_template_versions` (90d, keeping the newest 10 per
 *     template) — one archived body per operator edit; previously had no
 *     retention at all.
 *   - `notification_object_mutes` (on expiry) — a mute the dispatcher will
 *     never read again.
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
import { lt, sql } from 'drizzle-orm';
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

/**
 * Archived template bodies, written once per operator edit.
 *
 * This table had NO retention of any kind. Every save of every template in
 * the admin editor appended a row holding a full body, and nothing ever
 * removed one — monotonic growth driven purely by how often an operator
 * tunes wording.
 *
 * Age alone is the wrong rule here: a template edited twice in two years
 * would lose the history that makes the diff useful. So the pass is
 * age-bounded AND count-bounded — anything past the window is removed
 * except the most recent {@link TEMPLATE_VERSION_KEEP_MIN} versions of each
 * template, which always survive.
 */
export const TEMPLATE_VERSION_RETENTION_DAYS = 90;

/** Always-kept most-recent versions per template, regardless of age. */
export const TEMPLATE_VERSION_KEEP_MIN = 10;

/**
 * The ceiling every notification-domain table is held to.
 *
 * `scripts/ci-notification-retention-check.sh` asserts that every window
 * exported from this module is >0 and <=90 days, and that each table named
 * below is actually deleted from by a pass in this file. A table that grows
 * without a bound is the failure this constant exists to make impossible to
 * reintroduce quietly.
 */
export const MAX_RETENTION_DAYS = 90;

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

/**
 * Delete archived template versions past the window, except the newest
 * TEMPLATE_VERSION_KEEP_MIN of each template.
 *
 * Single statement: computing the keep-set in JS would mean reading every
 * row of the table this exists to keep small.
 */
export async function purgeOldTemplateVersions(
  db: Database,
  retentionDays = TEMPLATE_VERSION_RETENTION_DAYS,
  keepMin = TEMPLATE_VERSION_KEEP_MIN,
): Promise<number> {
  if (retentionDays <= 0) return 0;
  const result = await db.execute<{ id: string }>(sql`
    DELETE FROM notification_template_versions
     WHERE id IN (
       SELECT id FROM (
         SELECT id,
                archived_at,
                ROW_NUMBER() OVER (PARTITION BY template_id ORDER BY version DESC) AS rn
           FROM notification_template_versions
       ) ranked
       WHERE ranked.rn > ${keepMin}
         AND ranked.archived_at < NOW() - (${retentionDays} * INTERVAL '1 day')
     )
    RETURNING id
  `);
  return (result.rows ?? []).length;
}

export interface NotificationRetentionResult {
  readonly deliveries: number;
  readonly notifications: number;
  readonly buckets: number;
  readonly templateVersions: number;
  readonly expiredMutes: number;
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
    templateVersions: await count('template versions', () => purgeOldTemplateVersions(db)),
    expiredMutes: await count('expired mutes', async () => {
      const { purgeExpiredMutes } = await import('../mutes/service.js');
      return purgeExpiredMutes(db);
    }),
  };
}

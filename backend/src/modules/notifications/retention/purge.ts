/**
 * Notification delivery audit-log retention.
 *
 * Default retention is 30 days. The daily cron in app.ts calls
 * `purgeOldDeliveries` to clear rows older than that.
 *
 * The notifications table itself is not purged — operator-facing
 * notifications are user-deletable and don't accumulate at the same
 * rate as the per-recipient delivery rows.
 */
import { lt, sql } from 'drizzle-orm';
import { notificationDeliveries } from '../../../db/schema.js';
import type { Database } from '../../../db/index.js';

export async function purgeOldDeliveries(
  db: Database,
  retentionDays = 30,
  now: Date = new Date(),
): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 3600 * 1000);
  const result = await db
    .delete(notificationDeliveries)
    .where(lt(notificationDeliveries.queuedAt, cutoff))
    .returning({ id: notificationDeliveries.id });
  return result.length;
}

/** Best-effort scheduler-friendly wrapper used by app.ts. */
export async function purgeOldDeliveriesSafe(db: Database): Promise<number> {
  try {
    return await purgeOldDeliveries(db);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[notifications] purge failed:', err instanceof Error ? err.message : err);
    return 0;
  }
}

// Silence unused-import warning when consumers only need the safe wrapper.
export const __sql = sql;

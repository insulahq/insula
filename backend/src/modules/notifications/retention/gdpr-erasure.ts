/**
 * GDPR Article 17 — right to erasure.
 *
 * Deletes every notification + delivery row for a given user. Called from
 * the user-deletion paths: admin-user delete (modules/admin-users/routes.ts)
 * and tenant-user delete (modules/tenants/sub-users-service.ts).
 *
 * The tenant-user path was missing until 2026-09-10. `notifications.user_id`
 * carries no FK, so nothing at the database layer cascades either — a
 * deleted tenant user's inbox rows were simply orphaned in place, keyed to
 * a user id that no longer resolves.
 *
 * Implementation note: deliveries are deleted FIRST so the FK from
 * deliveries → notifications doesn't block the second statement.
 */
import { eq } from 'drizzle-orm';
import { notifications, notificationDeliveries } from '../../../db/schema.js';
import type { Database } from '../../../db/index.js';

export interface EraseResult {
  readonly deliveriesDeleted: number;
  readonly notificationsDeleted: number;
}

/**
 * Erase within a caller-supplied transaction (or plain connection).
 *
 * Use this when the caller already owns a transaction — deleting a user and
 * erasing their notifications must commit or roll back together, otherwise a
 * crash between the two leaves orphan inbox rows that no later pass will
 * ever attribute to anyone.
 */
export async function eraseUserNotificationsInTx(
  tx: Database,
  userId: string,
): Promise<EraseResult> {
  const dels = await tx
    .delete(notificationDeliveries)
    .where(eq(notificationDeliveries.userId, userId))
    .returning({ id: notificationDeliveries.id });
  const notifs = await tx
    .delete(notifications)
    .where(eq(notifications.userId, userId))
    .returning({ id: notifications.id });
  return {
    deliveriesDeleted: dels.length,
    notificationsDeleted: notifs.length,
  };
}

/**
 * Erase in its own transaction. For callers that are not already inside one.
 *
 * Both DELETEs share a transaction so a crash between them can't leave the
 * audit log partially erased (deliveries gone, notifications surviving —
 * which would surface as orphan notifications with no delivery trail).
 */
export async function eraseUserNotifications(
  db: Database,
  userId: string,
): Promise<EraseResult> {
  // `as unknown as Database` matches the existing idiom for Drizzle's tx
  // (see modules/tenants/sub-users-service.ts:runInTransaction): PgTransaction
  // exposes the same query surface but is not structurally assignable.
  return await db.transaction(
    async (tx) => eraseUserNotificationsInTx(tx as unknown as Database, userId),
  );
}

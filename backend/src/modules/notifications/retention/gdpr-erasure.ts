/**
 * GDPR Article 17 — right to erasure.
 *
 * Deletes every notification + delivery row for a given user. Called
 * from the existing user-deletion path (account closure / tenant
 * delete cascade).
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

export async function eraseUserNotifications(
  db: Database,
  userId: string,
): Promise<EraseResult> {
  // Wrap both DELETEs in a single transaction so a crash between them
  // can't leave the audit log in a partially-erased state (deliveries
  // gone, notifications surviving — which would surface as orphan
  // notifications with no delivery trail).
  return await db.transaction(async (tx) => {
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
  });
}

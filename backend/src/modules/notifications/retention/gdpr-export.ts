/**
 * GDPR Article 15 — right of access export.
 *
 * Returns the notification + delivery history for one user in a shape
 * suitable for embedding into a larger account export bundle. Recipient
 * email is replaced with the stored hash — exporting raw PII into a
 * downloadable JSON would defeat the hash-at-write design.
 */
import { eq, desc } from 'drizzle-orm';
import { notifications, notificationDeliveries } from '../../../db/schema.js';
import type { Database } from '../../../db/index.js';

export interface ExportedNotification {
  readonly id: string;
  readonly categoryId: string | null;
  readonly severity: string;
  readonly title: string;
  readonly message: string;
  readonly locale: string;
  readonly eventId: string | null;
  readonly createdAt: string;
  readonly isRead: boolean;
  readonly readAt: string | null;
}

export interface ExportedDelivery {
  readonly id: string;
  readonly eventId: string;
  readonly categoryId: string;
  readonly channel: string;
  readonly status: string;
  readonly recipientHash: string | null;
  readonly contentHash: string;
  readonly queuedAt: string;
  readonly sentAt: string | null;
  readonly failedAt: string | null;
}

export interface UserNotificationExport {
  readonly userId: string;
  readonly exportedAt: string;
  readonly notifications: readonly ExportedNotification[];
  readonly deliveries: readonly ExportedDelivery[];
}

export async function exportUserNotifications(
  db: Database,
  userId: string,
): Promise<UserNotificationExport> {
  const notifRows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt));

  const delivRows = await db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.userId, userId))
    .orderBy(desc(notificationDeliveries.queuedAt));

  return {
    userId,
    exportedAt: new Date().toISOString(),
    notifications: notifRows.map((n) => ({
      id: n.id,
      categoryId: n.categoryId ?? null,
      severity: n.severity,
      title: n.title,
      message: n.message,
      locale: n.locale,
      eventId: n.eventId ?? null,
      createdAt: n.createdAt.toISOString(),
      isRead: n.isRead === 1,
      readAt: n.readAt?.toISOString() ?? null,
    })),
    deliveries: delivRows.map((d) => ({
      id: d.id,
      eventId: d.eventId,
      categoryId: d.categoryId,
      channel: d.channel,
      status: d.status,
      recipientHash: d.recipientHash ?? null,
      contentHash: d.contentHash,
      queuedAt: d.queuedAt.toISOString(),
      sentAt: d.sentAt?.toISOString() ?? null,
      failedAt: d.failedAt?.toISOString() ?? null,
    })),
  };
}

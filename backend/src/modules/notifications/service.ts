import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { notifications } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { getActiveChannels } from './channels/registry.js';
import { notificationActionPath } from './action-path.js';
import { linkPathsFor } from './action-links.js';
import type { NotificationRecord } from './channels/types.js';
import type { Database } from '../../db/index.js';

interface CreateNotificationInput {
  readonly userId: string;
  readonly type: 'info' | 'warning' | 'error' | 'success';
  readonly title: string;
  readonly message: string;
  readonly resourceType?: string | null;
  readonly resourceId?: string | null;
  /**
   * The category this row belongs to. REQUIRED.
   *
   * It used to be optional, falling back to a synthetic `legacy.<type>`
   * category — which is how 67 in-app notifications ended up on a path that
   * reached no template, no email, no preference gate and no delivery audit.
   * Every caller now dispatches through a real category, so the fallback has
   * nothing left to catch and its absence is a compile error rather than a
   * silent downgrade.
   */
  readonly categoryId: string;
}

export async function createNotification(db: Database, input: CreateNotificationInput) {
  const id = crypto.randomUUID();
  // Phase 1: every row gets a category id. Call-sites that don't supply
  // one fall through to the legacy.<type> family so the dispatcher
  // metrics + operator delivery filters stay consistent. The legacy
  // categories are seeded by categories/seed.ts.
  const categoryId = input.categoryId;
  await db.insert(notifications).values({
    id,
    userId: input.userId,
    type: input.type,
    title: input.title,
    message: input.message,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    categoryId,
  });

  const [created] = await db.select().from(notifications).where(eq(notifications.id, id));
  return created;
}

export async function listNotifications(
  db: Database,
  userId: string,
  params: { limit?: number; unreadOnly?: boolean },
) {
  const limit = Math.min(params.limit ?? 20, 100);
  const conditions = [eq(notifications.userId, userId)];

  if (params.unreadOnly) {
    conditions.push(eq(notifications.isRead, 0));
  }

  const rows = await db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);

  // Attach the page each notification should open when clicked. Computed
  // here (not stored) so the map stays in one place and covers historical
  // rows too — the frontend just navigates to `actionPath`.
  return rows.map((row) => ({
    ...row,
    actionPath: notificationActionPath({
      categoryId: row.categoryId ?? null,
      resourceType: row.resourceType ?? null,
      resourceId: row.resourceId ?? null,
    }),
    // A notification can carry more than one useful destination — the tenant
    // it is about AND the subsystem page that acts on it. Computed here for
    // the same reason `actionPath` is: one registry, and historical rows get
    // the links without a column to backfill.
    links: linkPathsFor({
      categoryId: row.categoryId ?? '',
      resourceType: row.resourceType ?? null,
      resourceId: row.resourceId ?? null,
      tenantId: row.tenantId ?? null,
    }),
  }));
}

export async function markAsRead(db: Database, userId: string, ids: string[]) {
  await db
    .update(notifications)
    .set({ isRead: 1, readAt: new Date() })
    .where(and(eq(notifications.userId, userId), inArray(notifications.id, ids)));
}

/** Mark every unread notification for the user as read. Single-shot
 *  for the bell-badge "Mark all read" affordance — the per-id endpoint
 *  only covers the visible top-N which silently leaves a stale badge
 *  when the user has more unread than the dropdown displays. */
export async function markAllAsRead(db: Database, userId: string): Promise<number> {
  const result = await db
    .update(notifications)
    .set({ isRead: 1, readAt: new Date() })
    .where(and(eq(notifications.userId, userId), eq(notifications.isRead, 0)))
    .returning({ id: notifications.id });
  return result.length;
}

export async function getUnreadCount(db: Database, userId: string): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`count(*)` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.isRead, 0)));

  return Number(result?.count ?? 0);
}

/**
 * Delete EVERY notification belonging to the user, in one statement.
 *
 * Deliberately server-side rather than a client loop over the rows the page
 * happens to have fetched: the list endpoint caps at 100, so a loop would
 * leave the 101st onward in place while reporting success — the same trap
 * `markAllAsRead` exists to avoid for the unread badge.
 *
 * Total by design, not scoped to the page's read-state filter. The filter is
 * a view; this is an account-wide action, and the UI names the full count in
 * its confirmation so the two can't be confused.
 */
export async function deleteAllNotifications(db: Database, userId: string): Promise<number> {
  const result = await db
    .delete(notifications)
    .where(eq(notifications.userId, userId))
    .returning({ id: notifications.id });
  return result.length;
}

export async function deleteNotification(db: Database, userId: string, id: string) {
  const [notification] = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)));

  if (!notification) {
    throw new ApiError('NOTIFICATION_NOT_FOUND', `Notification '${id}' not found`, 404, { notification_id: id });
  }

  await db.delete(notifications).where(eq(notifications.id, id));
}



import { z } from 'zod';

export const notificationResponseSchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: z.enum(['info', 'warning', 'error', 'success']),
  title: z.string(),
  message: z.string(),
  resourceType: z.string().nullable(),
  resourceId: z.string().nullable(),
  isRead: z.number(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
  /** In-app page the notification opens when clicked (server-resolved from the
   *  category). Null for the legacy family, which has no specific landing page. */
  actionPath: z.string().nullable(),
});

export type NotificationResponse = z.infer<typeof notificationResponseSchema>;

export const markNotificationsReadSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});

export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadSchema>;

export const unreadCountResponseSchema = z.object({
  count: z.number(),
});

export type UnreadCountResponse = z.infer<typeof unreadCountResponseSchema>;

/**
 * POST /admin/notifications/mutes — per-object mute (ROADMAP R29a).
 *
 * Authored from what the HANDLER reads, not from a caller: there is no
 * admin-panel consumer yet, so there is no shipped body shape to match. The
 * handler reads exactly these four fields; `createdBy` comes from the JWT, not
 * the body.
 *
 * Deliberately shape-only. The day RANGE (1..MAX_MUTE_DAYS) and whether a
 * category may be muted at all are business rules owned by `createMute`, which
 * raises `MuteRejected` with a message naming the offending category. Encoding
 * them here as well would duplicate the rule in two places and downgrade a
 * specific 400 into a generic validation error.
 *
 * `.strict()` because Zod strips unknown keys by default: without it a typo'd
 * field is silently dropped and the request still returns 200 having muted
 * something other than what the caller meant.
 */
export const createNotificationMuteSchema = z.object({
  objectKey: z.string().min(1).max(512),
  days: z.number().int().positive(),
  categoryId: z.string().min(1).max(128).nullable().optional(),
  reason: z.string().max(1000).optional(),
}).strict();
export type CreateNotificationMuteInput = z.infer<typeof createNotificationMuteSchema>;

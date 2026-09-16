import { z } from 'zod';

/**
 * Per-object notification mutes (ROADMAP: notification overhaul phase 8).
 *
 * Authored from what the HANDLER reads, not from what a panel sends — the
 * handler reads categoryId, objectKey, days and reason, and nothing else.
 */

/**
 * Longest a mute may last. Mirrors MAX_MUTE_DAYS in the mute service; an
 * indefinite mute is the permanent silence the feature exists to prevent,
 * reached one "temporarily" at a time.
 */
export const MAX_MUTE_DAYS = 30;

/**
 * `.strict()` deliberately: an unknown key here is a caller believing they
 * configured something that is in fact being stripped and ignored. Zod's
 * default is to strip silently, which is the exact behaviour this guard
 * family exists to remove.
 */
export const createNotificationMuteSchema = z.object({
  /** NULL/absent mutes the object across every category that names it. */
  categoryId: z.string().min(1).max(64).nullish(),
  objectKey: z.string().min(1).max(255),
  days: z.number().int().min(1).max(MAX_MUTE_DAYS),
  reason: z.string().max(1000).nullish(),
}).strict();

export type CreateNotificationMuteInput = z.infer<typeof createNotificationMuteSchema>;

/** Query params for DELETE — the pair that identifies one mute. */
export const deleteNotificationMuteSchema = z.object({
  categoryId: z.string().min(1).max(64).nullish(),
  objectKey: z.string().min(1).max(255),
}).strict();

export type DeleteNotificationMuteInput = z.infer<typeof deleteNotificationMuteSchema>;

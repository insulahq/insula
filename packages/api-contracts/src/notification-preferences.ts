/**
 * API contracts for per-user notification preferences and settings.
 *
 * Preferences = matrix of (category, channel) → enabled flag.
 * Settings    = per-user singleton (quiet hours, locale, digest mode).
 *
 * Mandatory categories ignore the enabled=false for in_app + email; the
 * backend dispatcher enforces this. The UI surfaces the lock visually.
 */

import { z } from 'zod';
import { NOTIFICATION_CHANNEL_ID } from './notification-categories.js';

export const NOTIFICATION_DIGEST_MODE = ['immediate', 'hourly', 'daily'] as const;
export type NotificationDigestMode = typeof NOTIFICATION_DIGEST_MODE[number];

export const userNotificationPreferenceResponseSchema = z.object({
  categoryId: z.string(),
  channel: z.enum(NOTIFICATION_CHANNEL_ID),
  enabled: z.boolean(),
  isMandatory: z.boolean(),
});
export type UserNotificationPreferenceResponse = z.infer<typeof userNotificationPreferenceResponseSchema>;

export const userNotificationPreferencesResponseSchema = z.object({
  preferences: z.array(userNotificationPreferenceResponseSchema),
});
export type UserNotificationPreferencesResponse = z.infer<typeof userNotificationPreferencesResponseSchema>;

export const updateUserNotificationPreferencesSchema = z.object({
  updates: z.array(z.object({
    categoryId: z.string().min(1).max(64),
    channel: z.enum(NOTIFICATION_CHANNEL_ID),
    enabled: z.boolean(),
  })).min(1).max(200),
});
export type UpdateUserNotificationPreferencesInput = z.infer<typeof updateUserNotificationPreferencesSchema>;

const timeStringSchema = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);

export const userNotificationSettingsResponseSchema = z.object({
  quietHoursStart: z.string().nullable(),
  quietHoursEnd: z.string().nullable(),
  timezone: z.string().nullable(),
  digestMode: z.enum(NOTIFICATION_DIGEST_MODE),
  locale: z.string(),
});
export type UserNotificationSettingsResponse = z.infer<typeof userNotificationSettingsResponseSchema>;

export const updateUserNotificationSettingsSchema = z.object({
  quietHoursStart: timeStringSchema.nullable().optional(),
  quietHoursEnd: timeStringSchema.nullable().optional(),
  timezone: z.string().max(50).nullable().optional(),
  digestMode: z.enum(NOTIFICATION_DIGEST_MODE).optional(),
  locale: z.string().min(2).max(8).optional(),
}).refine(
  (data) => (data.quietHoursStart === undefined && data.quietHoursEnd === undefined)
    || (data.quietHoursStart === null && data.quietHoursEnd === null)
    || (typeof data.quietHoursStart === 'string' && typeof data.quietHoursEnd === 'string'),
  { message: 'quietHoursStart and quietHoursEnd must be set/cleared together' },
);
export type UpdateUserNotificationSettingsInput = z.infer<typeof updateUserNotificationSettingsSchema>;

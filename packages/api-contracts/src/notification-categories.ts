/**
 * API contracts for notification categories — the "what kind of event"
 * taxonomy that drives template lookup, opt-out enforcement and
 * audience routing.
 *
 * Single source of truth for both backend Zod validation and frontend
 * type inference. See ../README for the contract-package rules.
 */

import { z } from 'zod';

export const NOTIFICATION_SEVERITY = ['info', 'warning', 'error', 'critical'] as const;
export type NotificationSeverity = typeof NOTIFICATION_SEVERITY[number];

export const NOTIFICATION_AUDIENCE = ['tenant', 'admin', 'system'] as const;
export type NotificationAudience = typeof NOTIFICATION_AUDIENCE[number];

/**
 * Every delivery channel the platform can route a notification through.
 *
 * This list is load-bearing well beyond validation: the backend seeds one
 * template per (category × channel) off it, and a guard fails the build
 * when a channel here has no templates behind it. Adding an entry is
 * therefore a commitment to ship its templates in the same change — see
 * `backend/src/modules/notifications/templates/seed-data.ts`.
 */
export const NOTIFICATION_CHANNEL_ID = ['in_app', 'email', 'ntfy'] as const;
export type NotificationChannelId = typeof NOTIFICATION_CHANNEL_ID[number];

/** Narrow an untrusted string (query param, DB column) to a known channel. */
export function isNotificationChannelId(value: unknown): value is NotificationChannelId {
  return typeof value === 'string'
    && (NOTIFICATION_CHANNEL_ID as readonly string[]).includes(value);
}

export const NOTIFICATION_GDPR_BASIS = ['contract', 'legitimate_interest', 'consent'] as const;
export type NotificationGdprBasis = typeof NOTIFICATION_GDPR_BASIS[number];

export const notificationCategoryResponseSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  audience: z.enum(NOTIFICATION_AUDIENCE),
  defaultSeverity: z.enum(NOTIFICATION_SEVERITY),
  defaultChannels: z.array(z.enum(NOTIFICATION_CHANNEL_ID)),
  isMandatory: z.boolean(),
  gdprBasis: z.enum(NOTIFICATION_GDPR_BASIS),
  rateLimitWindowS: z.number().int().nullable(),
  rateLimitMax: z.number().int().nullable(),
  isActive: z.boolean(),
  /**
   * Phase 5: optional per-source email-provider routing. NULL → the
   * worker uses the default platform email provider; otherwise it
   * sends through this specific notification_providers row. The UI
   * surfaces this as a "Send via" dropdown on the Source editor.
   */
  emailProviderId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type NotificationCategoryResponse = z.infer<typeof notificationCategoryResponseSchema>;

export const updateNotificationCategorySchema = z.object({
  defaultChannels: z.array(z.enum(NOTIFICATION_CHANNEL_ID)).optional(),
  defaultSeverity: z.enum(NOTIFICATION_SEVERITY).optional(),
  rateLimitWindowS: z.number().int().min(1).max(86400).nullable().optional(),
  rateLimitMax: z.number().int().min(1).max(10000).nullable().optional(),
  isActive: z.boolean().optional(),
  /** Phase 5: pass null to clear the override (revert to default). */
  emailProviderId: z.string().uuid().nullable().optional(),
}).refine(
  (data) => (data.rateLimitWindowS === undefined) === (data.rateLimitMax === undefined)
    || (data.rateLimitWindowS === null && data.rateLimitMax === null),
  { message: 'rateLimitWindowS and rateLimitMax must be set/cleared together' },
);
export type UpdateNotificationCategoryInput = z.infer<typeof updateNotificationCategorySchema>;

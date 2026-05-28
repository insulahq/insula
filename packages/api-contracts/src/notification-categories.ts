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

export const NOTIFICATION_CHANNEL_ID = ['in_app', 'email'] as const;
export type NotificationChannelId = typeof NOTIFICATION_CHANNEL_ID[number];

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
}).refine(
  (data) => (data.rateLimitWindowS === undefined) === (data.rateLimitMax === undefined)
    || (data.rateLimitWindowS === null && data.rateLimitMax === null),
  { message: 'rateLimitWindowS and rateLimitMax must be set/cleared together' },
);
export type UpdateNotificationCategoryInput = z.infer<typeof updateNotificationCategorySchema>;

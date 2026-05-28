/**
 * API contracts for the notification delivery audit log.
 *
 * Surfaces per-channel outcomes (queued/sent/failed/dlq/skipped/...) for
 * operator triage. Returns hashes for recipient + content — never raw
 * PII (GDPR).
 */

import { z } from 'zod';
import { NOTIFICATION_CHANNEL_ID } from './notification-categories.js';

export const NOTIFICATION_DELIVERY_STATUS = [
  'queued', 'sending', 'sent', 'failed', 'dlq', 'skipped', 'rate_limited', 'muted',
] as const;
export type NotificationDeliveryStatus = typeof NOTIFICATION_DELIVERY_STATUS[number];

export const notificationDeliveryResponseSchema = z.object({
  id: z.string(),
  notificationId: z.string().nullable(),
  eventId: z.string(),
  userId: z.string().nullable(),
  tenantId: z.string().nullable(),
  categoryId: z.string(),
  channel: z.enum(NOTIFICATION_CHANNEL_ID),
  providerId: z.string().nullable(),
  recipientHash: z.string().nullable(),
  contentHash: z.string(),
  templateId: z.string().nullable(),
  templateVersion: z.number().int(),
  locale: z.string(),
  status: z.enum(NOTIFICATION_DELIVERY_STATUS),
  attempt: z.number().int(),
  maxAttempts: z.number().int(),
  nextAttemptAt: z.string().nullable(),
  lastError: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  queuedAt: z.string(),
  sentAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  failedAt: z.string().nullable(),
});
export type NotificationDeliveryResponse = z.infer<typeof notificationDeliveryResponseSchema>;

export const listNotificationDeliveriesQuerySchema = z.object({
  channel: z.enum(NOTIFICATION_CHANNEL_ID).optional(),
  status: z.enum(NOTIFICATION_DELIVERY_STATUS).optional(),
  categoryId: z.string().max(64).optional(),
  tenantId: z.string().max(36).optional(),
  sinceSeconds: z.coerce.number().int().min(60).max(7 * 24 * 3600).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
export type ListNotificationDeliveriesQuery = z.infer<typeof listNotificationDeliveriesQuerySchema>;

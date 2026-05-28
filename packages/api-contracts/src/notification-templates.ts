/**
 * API contracts for notification templates — operator-editable Handlebars
 * sources keyed by (category, channel, locale).
 *
 * Body formats per channel:
 *   email   → 'mjml' (compiled to HTML by the renderer)
 *   in_app  → 'plaintext' or 'markdown'
 *
 * Subject is required for email, optional for in_app.
 */

import { z } from 'zod';
import { NOTIFICATION_CHANNEL_ID } from './notification-categories.js';

export const NOTIFICATION_BODY_FORMAT = ['mjml', 'html', 'plaintext', 'markdown'] as const;
export type NotificationBodyFormat = typeof NOTIFICATION_BODY_FORMAT[number];

export const notificationTemplateVariableSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  type: z.enum(['string', 'number', 'boolean', 'date']),
  required: z.boolean().optional(),
});
export type NotificationTemplateVariable = z.infer<typeof notificationTemplateVariableSchema>;

export const notificationTemplateResponseSchema = z.object({
  id: z.string(),
  categoryId: z.string(),
  channel: z.enum(NOTIFICATION_CHANNEL_ID),
  locale: z.string(),
  subjectTemplate: z.string().nullable(),
  bodyTemplate: z.string(),
  bodyFormat: z.enum(NOTIFICATION_BODY_FORMAT),
  variablesSchema: z.array(notificationTemplateVariableSchema).nullable(),
  isActive: z.boolean(),
  isSeed: z.boolean(),
  version: z.number().int(),
  editedByUserId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type NotificationTemplateResponse = z.infer<typeof notificationTemplateResponseSchema>;

const baseTemplateInput = {
  subjectTemplate: z.string().max(255).nullable().optional(),
  bodyTemplate: z.string().min(1).max(64000),
};

export const updateNotificationTemplateSchema = z.object({
  ...baseTemplateInput,
}).partial().refine(
  (data) => Object.keys(data).length > 0,
  { message: 'at least one field required' },
);
export type UpdateNotificationTemplateInput = z.infer<typeof updateNotificationTemplateSchema>;

export const previewNotificationTemplateSchema = z.object({
  variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  locale: z.string().optional(),
});
export type PreviewNotificationTemplateInput = z.infer<typeof previewNotificationTemplateSchema>;

export const previewNotificationTemplateResponseSchema = z.object({
  subject: z.string().nullable(),
  body: z.string(),
  bodyFormat: z.enum(NOTIFICATION_BODY_FORMAT),
});
export type PreviewNotificationTemplateResponse = z.infer<typeof previewNotificationTemplateResponseSchema>;

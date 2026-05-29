/**
 * API contracts for Notification Providers.
 *
 * Distinct from `smtp-relay.ts` (which is the tenant-side outbound mail
 * relay catalog). Notification Providers are platform-internal transport
 * endpoints that the notification dispatcher uses to deliver platform
 * notifications (lifecycle, security, billing, ...) to tenants and
 * operators.
 *
 * Phase 3 covers SMTP-based provider types only. The `provider_type`
 * discriminator is used to render the appropriate form fields:
 *   - `stalwart-internal` — uses the platform's own Stalwart instance
 *     (operator provides the master credentials manually after
 *     creating a real sender mailbox; see the 2026-05-28 spike).
 *   - `smtp` — generic SMTP submission.
 *   - `postmark` / `brevo` / `mailjet` / `mailgun-eu` — SaaS providers
 *     reached via their SMTP submission endpoint. The defaults wired
 *     into the form make each one a one-click setup.
 *
 * Future provider types (sms.*, webhook.*) would introduce new
 * channels and new shapes.
 */

import { z } from 'zod';
import { NOTIFICATION_CHANNEL_ID } from './notification-categories.js';

export const NOTIFICATION_PROVIDER_TYPE = [
  'stalwart-internal', 'smtp', 'postmark', 'brevo', 'mailjet', 'mailgun-eu',
] as const;
export type NotificationProviderType = typeof NOTIFICATION_PROVIDER_TYPE[number];

export const NOTIFICATION_PROVIDER_SCOPE = ['platform', 'tenant'] as const;
export type NotificationProviderScope = typeof NOTIFICATION_PROVIDER_SCOPE[number];

export const NOTIFICATION_PROVIDER_TEST_STATUS = ['success', 'failed'] as const;
export type NotificationProviderTestStatus = typeof NOTIFICATION_PROVIDER_TEST_STATUS[number];

/**
 * Response shape — credentials are NEVER returned. `authPasswordSet`
 * is a derived boolean indicating whether a password is stored, so the
 * admin UI can render "set / not set" without exposing the value.
 */
export const notificationProviderResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  providerType: z.enum(NOTIFICATION_PROVIDER_TYPE),
  scope: z.enum(NOTIFICATION_PROVIDER_SCOPE),
  tenantId: z.string().nullable(),
  channel: z.enum(NOTIFICATION_CHANNEL_ID),
  isDefault: z.boolean(),
  enabled: z.boolean(),
  smtpHost: z.string().nullable(),
  smtpPort: z.number().int(),
  smtpSecure: z.boolean(),
  authUsername: z.string().nullable(),
  authPasswordSet: z.boolean(),
  fromAddress: z.string(),
  fromName: z.string().nullable(),
  region: z.string().nullable(),
  lastTestedAt: z.string().nullable(),
  lastTestStatus: z.enum(NOTIFICATION_PROVIDER_TEST_STATUS).nullable(),
  lastTestError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdByUserId: z.string().nullable(),
});
export type NotificationProviderResponse = z.infer<typeof notificationProviderResponseSchema>;

/**
 * Create input — `auth_password` is plaintext; the backend encrypts it
 * with PLATFORM_ENCRYPTION_KEY before persisting. Field is required on
 * create when `auth_username` is set; on PATCH it is optional and a
 * NULL value leaves the stored password untouched.
 *
 * Phase 3 only accepts `scope: 'platform'` — tenant scope is reserved
 * for a future phase and explicitly rejected by the route handler.
 */
const baseProviderInput = {
  name: z.string().min(1).max(255),
  smtpHost: z.string().min(1).max(255),
  smtpPort: z.number().int().min(1).max(65_535).default(587),
  smtpSecure: z.boolean().default(false),
  authUsername: z.string().max(255).nullable().optional(),
  authPassword: z.string().min(1).max(500).optional(),
  fromAddress: z.string().email(),
  fromName: z.string().max(255).nullable().optional(),
  region: z.string().max(50).nullable().optional(),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
};

/**
 * Phase 6 prep: 'stalwart-internal' has DIFFERENT auth semantics from
 * every other provider type. The worker reads the platform master
 * account credentials from the K8s Secret `mail/mail-secrets` at send
 * time and uses them for SMTP authentication AND envelope sender —
 * the operator never enters a password, only the From: address that
 * recipients will see. `auth_username` / `auth_password` are therefore
 * ignored for this type and the validator rejects them so misuse is
 * loud rather than confusing.
 */
export const createNotificationProviderSchema = z.object({
  providerType: z.enum(NOTIFICATION_PROVIDER_TYPE),
  ...baseProviderInput,
}).refine(
  (data) => data.providerType === 'stalwart-internal'
    ? data.authPassword === undefined && (data.authUsername === undefined || data.authUsername === null)
    : true,
  {
    message: 'stalwart-internal providers must not specify authUsername / authPassword — the worker uses the platform master account credentials from mail-secrets',
    path: ['authPassword'],
  },
);
export type CreateNotificationProviderInput = z.infer<typeof createNotificationProviderSchema>;

export const updateNotificationProviderSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  smtpHost: z.string().min(1).max(255).optional(),
  smtpPort: z.number().int().min(1).max(65_535).optional(),
  smtpSecure: z.boolean().optional(),
  authUsername: z.string().max(255).nullable().optional(),
  /** Optional on update — omit to leave existing password unchanged. */
  authPassword: z.string().min(1).max(500).optional(),
  fromAddress: z.string().email().optional(),
  fromName: z.string().max(255).nullable().optional(),
  region: z.string().max(50).nullable().optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});
export type UpdateNotificationProviderInput = z.infer<typeof updateNotificationProviderSchema>;

export const testNotificationProviderSchema = z.object({
  /** Recipient address for the test message. Required — operator
   *  supplies their own email. */
  recipientEmail: z.string().email(),
});
export type TestNotificationProviderInput = z.infer<typeof testNotificationProviderSchema>;

export const testNotificationProviderResponseSchema = z.object({
  status: z.enum(NOTIFICATION_PROVIDER_TEST_STATUS),
  testedAt: z.string(),
  error: z.string().nullable(),
});
export type TestNotificationProviderResponse = z.infer<typeof testNotificationProviderResponseSchema>;

/**
 * Suggested defaults the admin UI can preload when the operator picks
 * a provider_type from the dropdown. Each entry covers smtpHost + port
 * + secure mode; auth credentials stay operator-supplied.
 */
export const NOTIFICATION_PROVIDER_DEFAULTS: Record<
  NotificationProviderType,
  { smtpHost: string; smtpPort: number; smtpSecure: boolean; region?: string }
> = {
  'stalwart-internal': { smtpHost: 'stalwart-mail.mail.svc.cluster.local', smtpPort: 465, smtpSecure: true },
  'smtp':              { smtpHost: '',                                        smtpPort: 587, smtpSecure: false },
  'postmark':          { smtpHost: 'smtp.postmarkapp.com',                    smtpPort: 587, smtpSecure: false },
  'brevo':             { smtpHost: 'smtp-relay.brevo.com',                    smtpPort: 587, smtpSecure: false, region: 'eu' },
  'mailjet':           { smtpHost: 'in-v3.mailjet.com',                       smtpPort: 587, smtpSecure: false, region: 'eu' },
  'mailgun-eu':        { smtpHost: 'smtp.eu.mailgun.org',                     smtpPort: 587, smtpSecure: false, region: 'eu' },
};

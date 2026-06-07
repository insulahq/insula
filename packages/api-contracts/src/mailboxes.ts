import { z } from 'zod';
import { paginatedResponseSchema } from './shared.js';
import { createLoginPasswordResultSchema } from './login-passwords.js';

// No `password` field: a mailbox's human-facing credentials are "login
// passwords" (Stalwart app passwords). On create the backend mints a
// hidden, never-shown primary secret and auto-issues the first login
// password (returned once as `initialLoginPassword`). See ADR-049.
export const createMailboxSchema = z.object({
  local_part: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/, 'Invalid mailbox name'),
  display_name: z.string().max(255).optional(),
  quota_mb: z.number().int().min(50).max(102400).default(1024),
  mailbox_type: z.enum(['mailbox', 'forward_only']).default('mailbox'),
});

export type CreateMailboxInput = z.infer<typeof createMailboxSchema>;

// No `password` field — credentials are managed via login passwords.
export const updateMailboxSchema = z.object({
  display_name: z.string().max(255).optional(),
  quota_mb: z.number().int().min(50).max(102400).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  auto_reply: z.boolean().optional(),
  auto_reply_subject: z.string().max(255).optional(),
  auto_reply_body: z.string().max(10000).optional(),
});

export type UpdateMailboxInput = z.infer<typeof updateMailboxSchema>;

export const mailboxResponseSchema = z.object({
  id: z.string(),
  emailDomainId: z.string(),
  tenantId: z.string(),
  localPart: z.string(),
  fullAddress: z.string(),
  displayName: z.string().nullable(),
  quotaMb: z.number(),
  usedMb: z.number(),
  status: z.string(),
  mailboxType: z.string(),
  autoReply: z.number(),
  autoReplySubject: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Create response = the mailbox + the auto-issued first login password,
 * whose `secret` is shown ONCE here. `initialLoginPassword` is null when
 * the mailbox couldn't be provisioned to the mail server yet (e.g. the
 * domain isn't enabled) — the operator issues one later from the
 * mailbox's Login passwords section.
 */
export const createMailboxResultSchema = mailboxResponseSchema.extend({
  initialLoginPassword: createLoginPasswordResultSchema.nullable(),
});

export type CreateMailboxResult = z.infer<typeof createMailboxResultSchema>;

export type MailboxResponse = z.infer<typeof mailboxResponseSchema>;

// ─── Admin cross-tenant mailbox list ────────────────────────────────────────
//
// Returned by GET /admin/mailboxes for the admin Tenants → Email Accounts
// tab. Mailbox row joined to its tenant + email domain so the UI can render
// tenant/domain columns without a second fetch.
export const adminMailboxResponseSchema = mailboxResponseSchema.extend({
  tenantName: z.string().nullable(),
  emailDomain: z.string().nullable(),
});

export type AdminMailboxResponse = z.infer<typeof adminMailboxResponseSchema>;

export const adminMailboxListResponseSchema = paginatedResponseSchema(adminMailboxResponseSchema);
export type AdminMailboxListResponse = z.infer<typeof adminMailboxListResponseSchema>;

export const mailboxAccessSchema = z.object({
  user_id: z.string().uuid(),
  access_level: z.enum(['full', 'read_only']).default('full'),
});

export type MailboxAccessInput = z.infer<typeof mailboxAccessSchema>;

export const webmailEngineSchema = z.enum(['roundcube', 'bulwark']);
export type WebmailEngine = z.infer<typeof webmailEngineSchema>;

export const webmailTokenRequestSchema = z.object({
  mailbox_id: z.string().uuid(),
  /**
   * Engine to mint the token for. Defaults to `roundcube` for
   * backwards compatibility with the existing tenant-panel button.
   * Bulwark tokens carry additional claims (`iss`, `jti`,
   * `tenant_id`, `actor_user_id`) and resolve to a different URL
   * shape — see ADR-039.
   */
  engine: webmailEngineSchema.optional(),
});

export type WebmailTokenRequest = z.infer<typeof webmailTokenRequestSchema>;

export const webmailTokenResponseSchema = z.object({
  token: z.string(),
  mailbox: z.string(),
  webmailUrl: z.string(),
  engine: webmailEngineSchema,
});

export type WebmailTokenResponse = z.infer<typeof webmailTokenResponseSchema>;

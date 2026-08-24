import { z } from 'zod';
import { paginatedResponseSchema } from './shared.js';
import { createLoginPasswordResultSchema } from './login-passwords.js';

// Mailbox account types:
//   `mailbox`   — normal account: stores mail, IMAP/POP3/webmail access.
//   `send_only` — SMTP-submission-only account (e.g. no-reply@): can
//                 authenticate and send but has no usable inbox. Inbound
//                 mail is rejected with a bounce unless forwarding is set,
//                 in which case it is forwarded WITHOUT a local copy.
// The legacy `forward_only` enum value was never implemented or creatable
// and is intentionally absent here (DB rows are migrated to `mailbox`).
export const mailboxTypeSchema = z.enum(['mailbox', 'send_only']);
export type MailboxType = z.infer<typeof mailboxTypeSchema>;

// Forwarding targets. A `mailbox`-type account forwards AND keeps a local
// copy; a `send_only` account forwards without storing. Empty array = off.
export const forwardingAddressesSchema = z
  .array(z.string().email().max(255))
  .max(20);

// No `password` field: a mailbox's human-facing credentials are "login
// passwords" (Stalwart app passwords). On create the backend mints a
// hidden, never-shown primary secret and auto-issues the first login
// password (returned once as `initialLoginPassword`). See ADR-049.
export const createMailboxSchema = z.object({
  local_part: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/, 'Invalid mailbox name'),
  display_name: z.string().max(255).optional(),
  // Optional: when omitted the backend defaults it to the tenant's effective
  // max mailbox size (plan limit / per-tenant override). A supplied value
  // must not exceed that max — the backend rejects with
  // MAILBOX_QUOTA_EXCEEDS_LIMIT. The absolute ceiling here is a sanity bound.
  quota_mb: z.number().int().min(50).max(102400).optional(),
  mailbox_type: mailboxTypeSchema.default('mailbox'),
  forwarding_addresses: forwardingAddressesSchema.optional(),
}).superRefine((input, ctx) => {
  // A send-only account stores nothing, so a storage quota is meaningless —
  // reject it loudly instead of silently ignoring it.
  if (input.mailbox_type === 'send_only' && input.quota_mb !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['quota_mb'],
      message: 'quota_mb is not applicable to send-only accounts',
    });
  }
});

export type CreateMailboxInput = z.infer<typeof createMailboxSchema>;

// No `password` field — credentials are managed via login passwords.
// `mailbox_type` is intentionally NOT updatable: converting between a
// stored mailbox and a send-only account changes the Stalwart-side
// permission set and storage semantics — recreate instead.
export const updateMailboxSchema = z.object({
  display_name: z.string().max(255).optional(),
  quota_mb: z.number().int().min(50).max(102400).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  auto_reply: z.boolean().optional(),
  auto_reply_subject: z.string().max(255).optional(),
  auto_reply_body: z.string().max(10000).optional(),
  // Empty array disables forwarding. The backend rejects targets equal to
  // the mailbox's own address (mail loop) with FORWARDING_SELF_TARGET.
  forwarding_addresses: forwardingAddressesSchema.optional(),
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
  // null/[] = forwarding off. See forwardingAddressesSchema for semantics.
  forwardingAddresses: z.array(z.string()).nullable(),
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

import { z } from 'zod';

/**
 * Login passwords (a.k.a. app passwords) for a mailbox.
 *
 * Backed by Stalwart "AppPassword" registry objects — the server
 * generates the secret, which is shown EXACTLY ONCE (in the create
 * response) and never retrievable again. They authenticate anywhere the
 * mailbox password does (IMAP/SMTP/POP3/JMAP/CalDAV/CardDAV) and are the
 * human-facing credential set for a mailbox.
 *
 * Stateless on the platform side — there is no DB table; the list is read
 * live from Stalwart over JMAP.
 */

// A label is required: it's the only way an operator can tell which
// credential to revoke later (the secret is never shown again).
export const createLoginPasswordSchema = z.object({
  label: z.string().trim().min(1, 'Label is required').max(64),
  /** ISO-8601 date/datetime; omitted/null = never expires. */
  expiresAt: z.string().datetime().nullish(),
  /**
   * Optional IP / CIDR allow-list (v4 or v6, optional /prefix). When
   * non-empty the credential only authenticates from these sources.
   * A coarse charset gate rejects whitespace/control characters and
   * obvious junk before it reaches Stalwart (the authority on exact
   * CIDR syntax) — so an operator can't silently store an unusable
   * entry that leaves the credential effectively unrestricted.
   */
  allowedIps: z
    .array(
      z.string().trim().min(1).max(45).regex(
        /^[0-9a-fA-F.:]+(\/\d{1,3})?$/,
        'Each entry must be an IPv4/IPv6 address or CIDR',
      ),
    )
    .max(50)
    .optional(),
});

export type CreateLoginPasswordInput = z.infer<typeof createLoginPasswordSchema>;

/** Metadata for one login password — the secret is NEVER in this shape. */
export const loginPasswordSchema = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  /** IP/CIDR allow-list; empty array = unrestricted. */
  allowedIps: z.array(z.string()),
});

export type LoginPassword = z.infer<typeof loginPasswordSchema>;

export const loginPasswordListResponseSchema = z.object({
  data: z.array(loginPasswordSchema),
});

export type LoginPasswordListResponse = z.infer<typeof loginPasswordListResponseSchema>;

/**
 * Create response — the ONLY place the cleartext `secret` ever appears.
 * Surface it once to the operator, then it is unrecoverable.
 */
export const createLoginPasswordResultSchema = z.object({
  id: z.string(),
  label: z.string(),
  secret: z.string(),
  expiresAt: z.string().nullable(),
  allowedIps: z.array(z.string()),
});

export type CreateLoginPasswordResult = z.infer<typeof createLoginPasswordResultSchema>;

import { z } from 'zod';

/**
 * Mail drift API. Surfaces platform_db / Stalwart drift items detected by
 * the principals-sync reconciler — typically caused by a failed mail-stack
 * failover before the 2026-05-27 silent-loss fix shipped. See
 * stalwart-principals-sync.ts for detection logic.
 *
 * Two operator actions are exposed per item:
 *   - dismiss: acknowledge accepted loss / no action needed
 *   - recreate-empty: recreate the missing Stalwart entry; for domains
 *     this generates new DKIM keys (operator must republish at registrar),
 *     for mailboxes the new principal is empty (messages permanently lost
 *     unless restored via a separate snapshot-restore wizard, which is
 *     not yet built).
 */

// 'master-user' (2026-06-08): the webmail master principal that Bulwark +
// Roundcube authenticate as to impersonate every mailbox. If missing, ALL
// webmail login breaks — its remediation is recreate-via-rotate, not the
// per-mailbox recreate-empty/restore flow (see EmailDriftPage).
// 'orphan-domain' (2026-06-11, R17.2): the INVERSE direction — a Stalwart
// Domain principal that no platform email_domains row references and that
// is not the current mail-hostname cert anchor. Sources: hostname
// renames-away (the old cert-anchor row stays behind) and pre-#29
// tenant/domain FK-cascade deletions that never cleaned Stalwart.
// Remediation is operator-confirmed DELETION from Stalwart — never
// automatic (after a platform-DB PITR rollback a Stalwart domain with
// real mailboxes would look orphaned; auto-deletion would destroy mail).
export const mailDriftKindSchema = z.enum(['domain', 'mailbox', 'master-user', 'orphan-domain']);
export type MailDriftKind = z.infer<typeof mailDriftKindSchema>;

export const mailDriftResolutionSchema = z.enum(['recreated', 'restored', 'dismissed', 'reappeared', 'deleted']);
export type MailDriftResolution = z.infer<typeof mailDriftResolutionSchema>;

export const mailDriftItemSchema = z.object({
  id: z.string().uuid(),
  kind: mailDriftKindSchema,
  /** Hostname for domain items; email address for mailbox items. */
  expectedName: z.string(),
  /** The stale Stalwart ID stored in the platform DB row. */
  expectedStalwartId: z.string().nullable(),
  /** Platform DB row ID (email_domains.id or mailboxes.id depending on kind). */
  platformRowId: z.string(),
  firstDetectedAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
  resolvedVia: mailDriftResolutionSchema.nullable(),
  notes: z.string().nullable(),
});

export type MailDriftItem = z.infer<typeof mailDriftItemSchema>;

export const mailDriftListResponseSchema = z.object({
  items: z.array(mailDriftItemSchema),
  /** True when at least one active item exists — UI uses this for badge visibility. */
  hasActive: z.boolean(),
});

export type MailDriftListResponse = z.infer<typeof mailDriftListResponseSchema>;

/** POST /admin/mail/drift/:id/dismiss — no body, returns the updated item. */
export const mailDriftDismissResponseSchema = z.object({
  item: mailDriftItemSchema,
});
export type MailDriftDismissResponse = z.infer<typeof mailDriftDismissResponseSchema>;

/**
 * POST /admin/mail/drift/:id/recreate-empty — type-to-confirm guarded.
 *
 * For DOMAIN items: creates a fresh Stalwart Domain entry, then updates
 *   email_domains.stalwart_domain_id. NEW DKIM keys are generated — the
 *   admin MUST republish the new DKIM TXT records at the tenant's DNS
 *   registrar before the recreated mail flow can sign-validate.
 *
 * For MAILBOX items: creates a fresh Stalwart Principal with the
 *   tenant-stored password. Mailbox is EMPTY — all prior messages are
 *   permanently unrecoverable from Stalwart (operator can still ingest
 *   via tenant-bundle restore or .eml import out-of-band).
 *
 * The frontend MUST enforce type-to-confirm (the operator types the
 * expected_name as a confirmation token); this server-side check is
 * a backstop only.
 */
export const mailDriftRecreateRequestSchema = z.object({
  confirmName: z.string().min(1, 'confirm token required'),
});
export type MailDriftRecreateRequest = z.infer<typeof mailDriftRecreateRequestSchema>;

export const mailDriftRecreateResponseSchema = z.object({
  item: mailDriftItemSchema,
  /** Newly-allocated Stalwart ID for the recreated entry. */
  newStalwartId: z.string(),
  /** Free-form operator note explaining what was created + immediate follow-ups (e.g. publish DKIM). */
  followUp: z.string(),
});
export type MailDriftRecreateResponse = z.infer<typeof mailDriftRecreateResponseSchema>;

/**
 * delete-orphan (kind='orphan-domain' only) — DESTRUCTIVE deletion of an
 * orphaned Stalwart Domain principal + its DkimSignature rows. Same
 * type-to-confirm contract as recreate-empty. The server REFUSES with
 * ORPHAN_HAS_PRINCIPALS when the Domain still has member principals
 * linked (Stalwart objectIsLinked) — a domain carrying live mailboxes is
 * never safely deletable from this surface.
 */
export const mailDriftDeleteOrphanRequestSchema = z.object({
  confirmName: z.string().min(1, 'confirm token required'),
});
export type MailDriftDeleteOrphanRequest = z.infer<typeof mailDriftDeleteOrphanRequestSchema>;

export const mailDriftDeleteOrphanResponseSchema = z.object({
  item: mailDriftItemSchema,
  /** How many DkimSignature rows were destroyed alongside the Domain. */
  dkimSignaturesDeleted: z.number().int().min(0),
});
export type MailDriftDeleteOrphanResponse = z.infer<typeof mailDriftDeleteOrphanResponseSchema>;

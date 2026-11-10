import { z } from 'zod';

// max_mailboxes + max_quota_mb removed in round-2 refactor. Total
// mailbox count is now capped at the plan level via
// hosting_plans.max_mailboxes + tenants.max_mailboxes_override.
// See backend/src/modules/mailboxes/limit.ts.

export const enableEmailDomainSchema = z.object({
  catch_all_address: z.string().email().optional(),
  // 2026-05-18: per-tenant webmail subdomain (webmail.<clientdomain>)
  // now defaults OFF. The shared platform-wide webmail URL
  // (webmail.<apex>) is the recommended entry point — it works for
  // every tenant without per-domain DNS + cert lifecycle overhead.
  // Operators or tenant_admins who want a vanity webmail URL per
  // customer domain can opt in by setting this to true at enable
  // time, OR toggle it later via PATCH /email/domains/:id
  // {webmail_enabled: true}.
  webmail_enabled: z.boolean().optional().default(false),
});

export type EnableEmailDomainInput = z.infer<typeof enableEmailDomainSchema>;

export const updateEmailDomainSchema = z.object({
  enabled: z.boolean().optional(),
  // Phase 2c.5: toggle the derived webmail.<domain> Ingress
  webmail_enabled: z.boolean().optional(),
  catch_all_address: z.string().email().nullable().optional(),
  // spam_threshold_junk / spam_threshold_reject were removed: the mail server
  // never applied them, and Stalwart has ONE threshold for the whole server —
  // now the operator's `spamJunkScore` / `spamRejectScore` mail setting. An
  // older client still sending them is stripped by Zod, not refused.
});

export type UpdateEmailDomainInput = z.infer<typeof updateEmailDomainSchema>;

// Round-4 Phase 2: webmail provisioning lifecycle status.
export const webmailStatusEnum = z.enum(['pending', 'ready', 'ready_no_tls', 'failed']);
export type WebmailStatus = z.infer<typeof webmailStatusEnum>;

export const emailDomainResponseSchema = z.object({
  id: z.string(),
  domainId: z.string(),
  tenantId: z.string(),
  domainName: z.string(),
  enabled: z.number(),
  webmailEnabled: z.number().optional(),
  // Round-4 Phase 2 — webmail provisioning lifecycle (lifecycle
  // tracker columns added in migration 0021).
  webmailStatus: webmailStatusEnum.optional(),
  webmailStatusMessage: z.string().nullable().optional(),
  webmailStatusUpdatedAt: z.string().nullable().optional(),
  dkimSelector: z.string(),
  dkimPublicKey: z.string().nullable(),
  catchAllAddress: z.string().nullable(),
  mxProvisioned: z.number(),
  spfProvisioned: z.number(),
  dkimProvisioned: z.number(),
  dmarcProvisioned: z.number(),
  mailboxCount: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type EmailDomainResponse = z.infer<typeof emailDomainResponseSchema>;

// Round-4 Phase 1: disable preview. Returns the exact set of
// mailboxes, aliases, DNS records, and DKIM keys that would be
// removed when the tenant calls `DELETE .../disable` for this
// email domain. Used by the tenant panel to render a complete
// confirmation warning.
export const emailDomainDisablePreviewSchema = z.object({
  emailDomainId: z.string(),
  domainName: z.string(),
  mailboxes: z.array(
    z.object({
      id: z.string(),
      fullAddress: z.string(),
    }),
  ),
  aliases: z.array(
    z.object({
      id: z.string(),
      sourceAddress: z.string(),
    }),
  ),
  dnsRecords: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      name: z.string().nullable(),
      purpose: z.string().nullable(),
    }),
  ),
  dkimKeys: z.array(
    z.object({
      id: z.string(),
      selector: z.string(),
      status: z.string(),
    }),
  ),
  webmailHostname: z.string().nullable(),
});

export type EmailDomainDisablePreview = z.infer<typeof emailDomainDisablePreviewSchema>;

// ─── Mail DNS check and "Re-create mail records" ─────────────────────────
//
// GET  /tenants/:tenantId/email/domains/:domainId/dns-check
// POST /tenants/:tenantId/email/domains/:domainId/dns-records/repair
//
// The check reads the domain's live zone (only where the platform hosts it)
// and compares it with the mail records the platform publishes. `issues` are
// records of the zone that get in the way — a second SPF or DMARC record, an
// MX pointing at another provider. `repair` is exactly what the repair would
// change, so the confirmation can list it.

export const mailDnsRecordStatusSchema = z.enum(['ok', 'missing', 'replaced']);
export type MailDnsRecordStatus = z.infer<typeof mailDnsRecordStatusSchema>;

export const mailDnsIssueKindSchema = z.enum([
  'duplicate_spf',
  'duplicate_dmarc',
  'foreign_mx',
  'foreign_srv',
  'outdated_platform_record',
  'spf_without_platform',
  'dmarc_reports_elsewhere',
]);
export type MailDnsIssueKind = z.infer<typeof mailDnsIssueKindSchema>;

const mailDnsRecordRefSchema = z.object({
  type: z.string(),
  name: z.string(),
  value: z.string(),
});

export const mailDnsCheckSchema = z.object({
  /**
   * False when the zone was not read: hosted elsewhere, a DNS server type that
   * cannot list a whole zone, or a server that did not answer.
   */
  checked: z.boolean(),
  reason: z.enum(['external_dns', 'zone_unlisted', 'zone_unreadable']).nullable(),
  records: z.array(mailDnsRecordRefSchema.extend({
    ttl: z.number(),
    priority: z.number().nullable(),
    purpose: z.string(),
    status: mailDnsRecordStatusSchema,
  })),
  issues: z.array(mailDnsRecordRefSchema.extend({
    kind: mailDnsIssueKindSchema,
    severity: z.enum(['error', 'warning']),
    message: z.string(),
    /** "Re-create mail records" removes this record. */
    removable: z.boolean(),
  })),
  repair: z.object({
    add: z.array(mailDnsRecordRefSchema.extend({ priority: z.number().nullable() })),
    remove: z.array(mailDnsRecordRefSchema.extend({
      /** The tenant may keep it (another MX or SRV target); merged and outdated records may not. */
      optional: z.boolean(),
    })),
    /** Stored rows brought in line with the zone; nothing in DNS changes for these. */
    storedFixes: z.number(),
  }),
});
export type MailDnsCheck = z.infer<typeof mailDnsCheckSchema>;

/** Optional records of the plan the tenant chose to keep (another MX or SRV target). */
export const mailDnsRepairRequestSchema = z.object({
  keep: z.array(mailDnsRecordRefSchema).max(100).default([]),
}).strict();
export type MailDnsRepairRequest = z.input<typeof mailDnsRepairRequestSchema>;

export const mailDnsRepairResultSchema = z.object({
  added: z.number(),
  removed: z.number(),
  failures: z.array(mailDnsRecordRefSchema.extend({
    action: z.enum(['add', 'remove']),
    message: z.string(),
  })),
  /** Optional records left in place because the tenant chose to keep them. */
  kept: z.number(),
  check: mailDnsCheckSchema,
});
export type MailDnsRepairResult = z.infer<typeof mailDnsRepairResultSchema>;

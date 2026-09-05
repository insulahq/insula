import { z } from 'zod';
import { uuidField, paginatedResponseSchema } from './shared.js';

const domainNameRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const createDomainSchema = z.object({
  domain_name: z.string().min(1).max(255).regex(domainNameRegex, 'Invalid domain name format'),
  dns_mode: z.enum(['primary', 'cname', 'secondary']).default('cname'),
  deployment_id: uuidField.optional(),
  dns_group_id: uuidField.optional(),
});

export const updateDomainSchema = z.object({
  dns_mode: z.enum(['primary', 'cname', 'secondary']).optional(),
  ssl_auto_renew: z.boolean().optional(),
  status: z.enum(['unverified', 'verified', 'active', 'pending', 'suspended', 'deleted']).optional(),
  deployment_id: uuidField.nullable().optional(),
  dns_group_id: uuidField.nullable().optional(),
});

// ─── DNS Provider Group Schemas ─────────────────────────────────────────────

export const createDnsProviderGroupSchema = z.object({
  name: z.string().min(1).max(255),
  is_default: z.boolean().optional(),
  ns_hostnames: z.array(z.string()).optional(),
});

export const updateDnsProviderGroupSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  is_default: z.boolean().optional(),
  ns_hostnames: z.array(z.string()).optional(),
});

export const migrateDnsSchema = z.object({
  target_group_id: uuidField,
});

export const dnsProviderGroupResponseSchema = z.object({
  id: uuidField,
  name: z.string(),
  isDefault: z.boolean(),
  nsHostnames: z.array(z.string()).nullable().optional(),
  serverCount: z.number().optional(),
  domainCount: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ─── Response Schemas ────────────────────────────────────────────────────────

export const domainResponseSchema = z.object({
  id: uuidField,
  tenantId: uuidField,
  domainName: z.string(),
  status: z.string(),
  dnsMode: z.string(),
  deploymentId: z.string().nullable().optional(),
  dnsGroupId: z.string().nullable().optional(),
  sslAutoRenew: z.number(),
  /** TLS certificate summary — enriched from ssl_certificates LEFT JOIN. */
  tlsCertStatus: z.enum(['active', 'expiring', 'expired', 'pending', 'failed', 'none']).optional(),
  tlsCertIssuer: z.string().nullable().optional(),
  tlsCertExpiresAt: z.string().nullable().optional(),
  tlsCertWildcard: z.boolean().optional(),
  /** Why the last issuance attempt failed, straight from cert-manager. */
  tlsCertError: z.string().nullable().optional(),
  tlsCertErrorAt: z.string().nullable().optional(),
  /** ClusterIssuer that signed (or is trying to sign) the certificate. */
  tlsCertIssuerName: z.string().nullable().optional(),
  /** True while per-hostname certs stand in for a failing wildcard. */
  tlsCertFallbackActive: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const domainListResponseSchema = paginatedResponseSchema(domainResponseSchema);

// ─── Delete preview (Phase 3 round-3) ────────────────────────────────────────

export const domainDeletePreviewSchema = z.object({
  domainName: z.string(),
  dnsRecords: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      name: z.string().nullable(),
    }),
  ),
  emailDomain: z
    .object({
      id: z.string(),
      webmailEnabled: z.boolean(),
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
    })
    .nullable(),
  ingressRoutes: z.array(
    z.object({
      id: z.string(),
      hostname: z.string(),
    }),
  ),
  webmailIngressHostname: z.string().nullable(),
});

// ─── Verification Response ────────────────────────────────────────────────────

export const verificationCheckSchema = z.object({
  type: z.string(),
  status: z.enum(['pass', 'fail']),
  detail: z.string(),
});

export const verificationResultSchema = z.object({
  verified: z.boolean(),
  checks: z.array(verificationCheckSchema),
  domainId: z.string(),
  domainName: z.string(),
  /** true when the result was served from the 24-hour cache, false when freshly computed */
  cached: z.boolean(),
});

export type VerificationCheck = z.infer<typeof verificationCheckSchema>;
export type VerificationResultResponse = z.infer<typeof verificationResultSchema>;

// ─── Types ───────────────────────────────────────────────────────────────────

export type CreateDomainInput = z.infer<typeof createDomainSchema>;

// ─── Request (wire) types ────────────────────────────────────────────────────
//
// `z.infer` is the OUTPUT type: a field declared `.default(x)` is REQUIRED
// there, because after parsing it always has a value. On the wire it is
// optional — the client may omit it and the backend fills it in.
//
// Typing a request body with the output type therefore marks every defaulted
// field as mandatory. Doing that surfaced three "missing required field"
// compile errors in working forms (catalog-repo sync interval, cron http_method,
// plan features) — all three fields have defaults, and all three forms were
// correct. A migration that trusted those errors would have changed working
// code to satisfy a type that was wrong.
//
// So: frontends type request bodies with `…Request` (= z.input), and the
// backend keeps using the `…Input` (= z.infer) type for `parsed.data`.
export type CreateDomainRequest = z.input<typeof createDomainSchema>;

export type UpdateDomainInput = z.infer<typeof updateDomainSchema>;
export type DomainResponse = z.infer<typeof domainResponseSchema>;
export type DomainListResponse = z.infer<typeof domainListResponseSchema>;
export type DomainDeletePreview = z.infer<typeof domainDeletePreviewSchema>;
export type CreateDnsProviderGroupInput = z.infer<typeof createDnsProviderGroupSchema>;
export type UpdateDnsProviderGroupInput = z.infer<typeof updateDnsProviderGroupSchema>;
/** Wire shapes (z.input) for the DNS provider-group endpoints. */
export type CreateDnsProviderGroupRequest = z.input<typeof createDnsProviderGroupSchema>;
export type UpdateDnsProviderGroupRequest = z.input<typeof updateDnsProviderGroupSchema>;
export type MigrateDnsInput = z.infer<typeof migrateDnsSchema>;
export type DnsProviderGroupResponse = z.infer<typeof dnsProviderGroupResponseSchema>;

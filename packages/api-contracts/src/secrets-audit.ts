/**
 * Secrets coverage audit (DR-bundle bundle-everything redesign).
 *
 * Under bundle-everything semantics, every Secret in the cluster
 * that isn't auto-managed by a controller ends up in the bundle by
 * default. There is no "uncovered" bucket. The audit's purpose is
 * informational: it shows the breakdown so operators can see what
 * the next bundle will contain.
 *
 * Five buckets:
 *   - denied         → in `secrets-denylist.ts`; never bundled.
 *   - skip-at-restore → in bundle, operator-marked "do not apply at
 *                      restore time" with a documented reason.
 *   - tier-1-platform → in bundle, applied by `conservative` restore
 *                      profile (platform/mail/cnpg-system/etc.).
 *   - tier-2-tenant   → in bundle, applied by `full` profile
 *                      (`client-*` namespace pattern).
 *   - unclassified    → in bundle, applied by `full` profile
 *                      (third-party / operator-installed namespaces).
 *
 * See docs/history/04-deployment/DR_BUNDLE_ROADMAP.md.
 */

import { z } from 'zod';

export const secretCoverageCategorySchema = z.enum([
  /** Auto-managed by a controller; never enters the bundle. */
  'denied',
  /** In bundle but operator-marked "skip at restore" via the allowlist. */
  'skip-at-restore',
  /** In bundle, applied by `conservative` restore profile. */
  'tier-1-platform',
  /** In bundle, applied by `full` restore profile (tenant namespace). */
  'tier-2-tenant',
  /** In bundle, applied by `full` restore profile (everything else). */
  'unclassified',
]);
export type SecretCoverageCategory = z.infer<typeof secretCoverageCategorySchema>;

/** A single Secret + its coverage classification. */
export const auditedSecretSchema = z.object({
  namespace: z.string().min(1).max(253),
  name: z.string().min(1).max(253),
  /** The k8s `type` field (e.g. `Opaque`, `kubernetes.io/tls`). */
  type: z.string().max(253),
  /** ISO timestamp of the Secret's `metadata.creationTimestamp`. */
  createdAt: z.string().datetime(),
  ageSeconds: z.number().int().min(0),
  /** OwnerReference[0].kind if present (e.g. `Certificate` for cert-manager). */
  ownerKind: z.string().nullable(),
  ownerName: z.string().nullable(),
  category: secretCoverageCategorySchema,
  /** Why the classifier put it in that bucket — human-readable, short. */
  reason: z.string(),
});
export type AuditedSecret = z.infer<typeof auditedSecretSchema>;

/** Aggregate audit result returned by `GET /admin/system-backup/secrets-audit`. */
export const secretsAuditResultSchema = z.object({
  generatedAt: z.string().datetime(),
  totalSecretsCount: z.number().int().min(0),
  byCategory: z.object({
    denied: z.number().int().min(0),
    tier1Platform: z.number().int().min(0),
    tier2Tenant: z.number().int().min(0),
    unclassified: z.number().int().min(0),
    skipAtRestore: z.number().int().min(0),
  }),
  /** Always true under bundle-everything (kept for forward-compat). */
  healthy: z.boolean(),
  /** Operator-marked entries that won't be re-applied under the
   *  default restore profiles. Useful for the UI to show "X items
   *  skipped at restore" without a second API call. */
  skipAtRestoreSecrets: z.array(auditedSecretSchema),
  /** Every Secret in the cluster + its category. Sorted by
   *  (category, namespace, name) for stable UI rendering. The UI
   *  filters client-side rather than re-querying per bucket. */
  allSecrets: z.array(auditedSecretSchema),
});
export type SecretsAuditResult = z.infer<typeof secretsAuditResultSchema>;

export const secretsAuditResponseSchema = z.object({ data: secretsAuditResultSchema });
export type SecretsAuditResponse = z.infer<typeof secretsAuditResponseSchema>;

// ─── Allowlist CRUD ────────────────────────────────────────────────────

/** One entry in the secrets-audit-allowlist ConfigMap.
 *  Semantics under bundle-everything: this Secret IS in the bundle,
 *  but no restore profile will apply it unless the operator passes
 *  `--override-skip-at-restore`. */
export const allowlistEntrySchema = z.object({
  namespace: z.string().min(1).max(253),
  name: z.string().min(1).max(253),
  /** Why this Secret should NOT be re-applied at restore time. Required. */
  reason: z.string().min(10).max(500),
  /** Set by the API from req.user.sub on write. */
  addedBy: z.string().max(200),
  addedAt: z.string().datetime(),
});
export type AllowlistEntry = z.infer<typeof allowlistEntrySchema>;

export const listAllowlistResponseSchema = z.object({
  data: z.object({ entries: z.array(allowlistEntrySchema) }),
});
export type ListAllowlistResponse = z.infer<typeof listAllowlistResponseSchema>;

export const addAllowlistEntryRequestSchema = z.object({
  namespace: z.string().min(1).max(253),
  name: z.string().min(1).max(253),
  reason: z.string().min(10).max(500),
});
export type AddAllowlistEntryRequest = z.infer<typeof addAllowlistEntryRequestSchema>;

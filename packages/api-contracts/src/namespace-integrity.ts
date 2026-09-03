import { z } from 'zod';

/**
 * Namespace integrity — the audit that compares a tenant's DESIRED cluster
 * state (namespace, PVC, ResourceQuota, NetworkPolicies) against what is
 * actually there.
 *
 * These types lived only in the admin panel's `use-namespace-integrity.ts`
 * hook until 2026-09-03, hand-declared and never checked against the server.
 * A hand-written frontend interface is self-consistent, so TypeScript can
 * never catch a field the API does not actually send — the same defect class
 * that hid the dropped redirect field in PR #359. They are contracts now.
 */

/**
 * `*_missing` findings are auto-repairable — the reconciler recreates the
 * resource from the tenant's plan.
 *
 * `resource_quota_exceeded` is NOT. It means the namespace's live
 * ResourceQuota reports `used > hard` for at least one resource, so the
 * apiserver is REJECTING new objects of that kind. Re-applying the quota
 * cannot fix it: the over-consumption is already on the cluster (typically a
 * PVC provisioned larger than the plan the tenant was later moved to). The
 * operator has to raise the plan or shrink the object, so this finding is
 * reported and never auto-repaired.
 */
export const integrityFindingSchema = z.enum([
  'namespace_missing',
  'pvc_missing',
  'resource_quota_missing',
  'network_policy_missing',
  'resource_quota_exceeded',
]);
export type IntegrityFinding = z.infer<typeof integrityFindingSchema>;

/**
 * One row of the live ResourceQuota, straight from `status.used` /
 * `status.hard` — NOT the plan values in the `resource_quotas` DB table.
 *
 * The distinction is the whole point of surfacing this: the tenant panel
 * reports consumed bytes against the PLAN, so a PVC provisioned larger than
 * the plan is invisible there. `requests.storage` counts what the PVC
 * REQUESTED, not what has been written into it, which is how a tenant can
 * read as "78.8 MB of 512Mi used" while being hard-blocked from creating any
 * new volume.
 */
export const quotaUsageSchema = z.object({
  /** Quota key exactly as Kubernetes reports it, e.g. `requests.storage`. */
  resource: z.string(),
  /** `status.used`, verbatim (e.g. `2Gi`, `100m`, `33554432`). */
  used: z.string(),
  /** `status.hard`, verbatim. */
  hard: z.string(),
  /** used ÷ hard. Null when either side could not be parsed. */
  usedRatio: z.number().nullable(),
  /** True when used > hard — admission for this resource is blocked. */
  exceeded: z.boolean(),
});
export type QuotaUsage = z.infer<typeof quotaUsageSchema>;

export const namespaceIntegrityReportSchema = z.object({
  tenantId: z.string(),
  name: z.string(),
  namespace: z.string(),
  findings: z.array(integrityFindingSchema),
  repaired: z.array(integrityFindingSchema),
  errors: z.array(z.string()),
  /**
   * Every resource in the namespace's ResourceQuota. Empty when the quota is
   * missing or unreadable — an empty array is NOT "quota is fine", so gate any
   * "all good" rendering on the absence of findings, not on this being empty.
   */
  quota: z.array(quotaUsageSchema),
});
export type NamespaceIntegrityReport = z.infer<typeof namespaceIntegrityReportSchema>;

import { z } from 'zod';

/**
 * Namespace integrity — the audit that compares a tenant's DESIRED state
 * (namespace, PVC, ResourceQuota, NetworkPolicies, and the limits on their
 * subscription) against what is actually on the cluster.
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
 * The two quota findings are NOT:
 *
 * `provisioned_exceeds_plan` — the tenant HOLDS more than their subscription
 * allows. Lowering a plan does not shrink anything the tenant already has, so
 * a tenant moved from a 2 GiB plan to a 512 MiB one keeps the 2 GiB volume.
 * Nothing breaks immediately, which is exactly why it goes unnoticed: the
 * tenant panel reports bytes WRITTEN against the plan, so a 2 GiB volume with
 * 79 MB in it reads as comfortably inside a 512 MiB limit. Only the operator
 * can decide between raising the plan and running a (destructive) shrink.
 *
 * `resource_quota_exceeded` — the live ResourceQuota reports `used > hard`, so
 * the apiserver is REJECTING new objects of that kind right now. Usually the
 * same root cause, one step further along.
 */
export const integrityFindingSchema = z.enum([
  'namespace_missing',
  'pvc_missing',
  'resource_quota_missing',
  'network_policy_missing',
  'provisioned_exceeds_plan',
  'resource_quota_exceeded',
]);
export type IntegrityFinding = z.infer<typeof integrityFindingSchema>;

/**
 * One resource, compared across the three places it is expressed. All values
 * are Kubernetes quantity strings (`512Mi`, `2Gi`, `100m`) or null when that
 * column does not apply.
 *
 *   subscription — the effective plan limit: the tenant's per-resource
 *                  override if set, otherwise the hosting plan's value. What
 *                  the customer is entitled to.
 *   enforced     — `status.hard` on the live ResourceQuota. What Kubernetes
 *                  is actually enforcing. Lags `subscription` until the quota
 *                  reconciler runs.
 *   provisioned  — what physically exists. Storage only: the tenant PVC's
 *                  `spec.resources.requests.storage`. This is the column the
 *                  admin panel never showed, and the reason a 2 GiB volume on
 *                  a 512 MiB plan was invisible from every screen.
 */
export const quotaComparisonSchema = z.object({
  resource: z.enum(['storage', 'cpu', 'memory']),
  label: z.string(),
  subscription: z.string(),
  enforced: z.string().nullable(),
  provisioned: z.string().nullable(),
  /** provisioned > subscription — the tenant holds more than the plan allows. */
  exceedsSubscription: z.boolean(),
  /** enforced ≠ subscription — the cluster quota has not caught up with the plan. */
  enforcedDiffers: z.boolean(),
  /** Live quota `used > hard` — the apiserver is rejecting new objects. */
  blocked: z.boolean(),
});
export type QuotaComparison = z.infer<typeof quotaComparisonSchema>;

export const namespaceIntegrityReportSchema = z.object({
  tenantId: z.string(),
  name: z.string(),
  namespace: z.string(),
  findings: z.array(integrityFindingSchema),
  repaired: z.array(integrityFindingSchema),
  errors: z.array(z.string()),
  /**
   * Subscription-vs-cluster comparison, one row per resource. Empty when the
   * namespace or its quota could not be read — an empty array is NOT "this
   * tenant is consistent", so gate any reassuring rendering on the absence of
   * findings, never on this being empty.
   */
  quota: z.array(quotaComparisonSchema),
});
export type NamespaceIntegrityReport = z.infer<typeof namespaceIntegrityReportSchema>;

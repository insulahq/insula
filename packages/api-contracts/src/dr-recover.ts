import { z } from 'zod';
import { mailboxRestoreModeSchema, restoreJobStatusSchema } from './restore.js';

// ─── One-button tenant DR recover (gap G1) ───────────────────────────────────
//
// `POST /api/v1/admin/dr/tenants/:tenantId/recover` orchestrates the existing
// restore-cart endpoints (provision → create cart → add items → execute) in a
// single admin call, recovering a tenant's data from an off-site bundle.
//
// The route reuses the real cart handlers via Fastify `app.inject`; these
// schemas describe only the outer recover request/response.

/**
 * Restorable component kinds a DR recover can pull from a bundle.
 *
 * Subset of the DB `backup_component_name` enum: `secrets` are re-issued by
 * provisioning (never restored from a bundle), so they are excluded here.
 */
export const drRecoverComponentSchema = z.enum(['files', 'mailboxes', 'config']);
export type DrRecoverComponent = z.infer<typeof drRecoverComponentSchema>;

/**
 * Request body for `POST /admin/dr/tenants/:tenantId/recover`.
 *
 * Every field is optional — an empty body recovers every component present in
 * the tenant's newest COMPLETED bundle, re-provisioning the namespace first.
 */
export const drRecoverRequestSchema = z.object({
  /** Bundle (`backup_jobs.id`) to recover from. Omit → newest COMPLETED bundle for the tenant. */
  bundleId: z.string().min(1).optional(),
  /** Components to recover. Omit → all present (completed) in the bundle. */
  components: z.array(drRecoverComponentSchema).min(1).optional(),
  /**
   * Optional node placement (gap G2). Forwarded into the provision step
   * (`triggerProvisionSchema.targetNode`) so the recovered tenant's resources
   * land on this specific cluster node — the provision endpoint validates the
   * node exists and pins the tenant to it. Omit → the provisioner auto-picks.
   * See `backend/src/modules/dr-recover/routes.ts`.
   */
  targetNode: z.string().min(1).optional(),
  /** Mailbox merge strategy for the mailboxes item. Default `merge-skip-duplicates`. */
  mailboxMode: mailboxRestoreModeSchema.optional(),
  /** Re-provision namespace/PVC/file-manager before restoring. Default `true`. */
  provision: z.boolean().optional(),
});
export type DrRecoverRequest = z.infer<typeof drRecoverRequestSchema>;

/**
 * Post-restore auto-reconcile report. After the restore cart completes the
 * recover route best-effort re-establishes the platform-side state the bundle
 * itself cannot carry: k8s Ingress (rebuilt from restored `ingress_routes`),
 * mail send-readiness (DKIM regenerated in Stalwart per email domain), and the
 * tenant's workloads (redeployed from their restored spec). Each step is
 * best-effort — a failure is counted here and surfaced in `residualGaps`, and
 * NEVER fails the recover. Absent when no reconcile ran (recover failed before
 * restore, or the cluster clients were unavailable).
 */
export const drRecoverReconcileSchema = z.object({
  /** k8s Ingress rebuild from the restored `ingress_routes` rows. */
  ingress: z.enum(['reconciled', 'failed', 'skipped']),
  /** Mail send-readiness: DKIM regenerated in Stalwart per tenant email domain. */
  mail: z.object({
    domainsTotal: z.number().int().nonnegative(),
    dkimRegenerated: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  /** Tenant workloads redeployed from their restored `deployments` rows. */
  workloads: z.object({
    total: z.number().int().nonnegative(),
    redeployed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
});
export type DrRecoverReconcile = z.infer<typeof drRecoverReconcileSchema>;

/**
 * Response body (wrapped in the standard `{ data }` envelope).
 *
 * The recover route drives the EXISTING synchronous `/execute` endpoint, so by
 * the time it returns, `status` is already terminal (`done` | `failed`). The
 * client can still `GET /admin/restores/carts/:cartId` for per-item detail.
 */
export const drRecoverResponseSchema = z.object({
  /** Restore cart (`restore_jobs.id`) created and executed. */
  cartId: z.string(),
  /** Bundle the recover ran against. */
  bundleId: z.string(),
  /** Components actually queued, in apply order (config → files → mailboxes). */
  components: z.array(drRecoverComponentSchema),
  /** Whether re-provisioning ran as part of this call. */
  provisioned: z.boolean(),
  /** Terminal cart status reflected from the synchronous `/execute` call. */
  status: restoreJobStatusSchema,
  /**
   * True when the tenant's DB row was ABSENT and this call re-created it from
   * the bundle's `meta.tenant` block (preserving the original tenantId +
   * namespace) before running provision + restore — the S4 cross-cluster /
   * cheap-multi-region unlock. False on the normal recover-an-existing-tenant
   * path. See `backend/src/modules/dr-recover/recreate.ts`.
   */
  recreated: z.boolean(),
  /**
   * Human-readable residual manual steps the operator must still perform after
   * a re-create+restore (empty on the normal path). Data + config are restored,
   * but e.g. workloads are not auto-redeployed and mail principals may need a
   * sync — the recover route cannot close these gaps on its own.
   */
  residualGaps: z.array(z.string()),
  /**
   * Best-effort post-restore reconcile report (ingress / mail DKIM / workloads).
   * Present when the reconcile ran after a completed restore; absent otherwise.
   */
  reconcile: drRecoverReconcileSchema.optional(),
});
export type DrRecoverResponse = z.infer<typeof drRecoverResponseSchema>;

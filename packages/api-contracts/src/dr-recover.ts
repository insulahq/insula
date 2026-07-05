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
   * Optional node hint. NOTE: the underlying provision endpoint
   * (`triggerProvisionSchema`) does not yet accept a node target, so this is
   * accepted for forward-compatibility but is NOT currently forwarded — see
   * `backend/src/modules/dr-recover/routes.ts`.
   */
  targetNode: z.string().min(1).optional(),
  /** Mailbox merge strategy for the mailboxes item. Default `merge-skip-duplicates`. */
  mailboxMode: mailboxRestoreModeSchema.optional(),
  /** Re-provision namespace/PVC/file-manager before restoring. Default `true`. */
  provision: z.boolean().optional(),
});
export type DrRecoverRequest = z.infer<typeof drRecoverRequestSchema>;

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
});
export type DrRecoverResponse = z.infer<typeof drRecoverResponseSchema>;

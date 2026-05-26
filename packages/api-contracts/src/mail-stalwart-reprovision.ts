import { z } from 'zod';

/**
 * Stalwart re-provision endpoint.
 *
 * POST /admin/mail/stalwart-reprovision  (requireRole: admin)
 *
 * Same code path as the 30-min scheduled `stalwart-domain-reconciler`,
 * but operator-triggered. Idempotent: every step checks whether the
 * underlying Stalwart object exists before creating it; never
 * destroys operator-customized objects or other domains/listeners.
 *
 * Result shape mirrors `StalwartReconcileResult` in the backend
 * module — booleans indicate WHETHER the step took action this run
 * (true = created/updated, false = already correct OR precondition
 * skipped, see `notes`).
 */

export const stalwartReprovisionResponseSchema = z.object({
  apex: z.string().nullable(),
  sanKey: z.string().nullable(),
  domainCreated: z.boolean(),
  acmeProviderCreated: z.boolean(),
  certManagementUpdated: z.boolean(),
  listenersCreated: z.array(z.string()),
  acmeRenewalFired: z.boolean(),
  notes: z.array(z.string()),
  noOp: z.boolean(),
});

export type StalwartReprovisionResponse = z.infer<typeof stalwartReprovisionResponseSchema>;

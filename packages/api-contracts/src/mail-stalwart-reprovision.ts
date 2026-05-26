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
  /** The operator-set mail hostname the reconciler used (null when unset). */
  mailHostname: z.string().nullable(),
  /** True when Stalwart SystemSettings.defaultHostname was patched. */
  defaultHostnameUpdated: z.boolean(),
  /** True when the Let's Encrypt AcmeProvider was created this run. */
  acmeProviderCreated: z.boolean(),
  /** Names of NetworkListeners newly created (subset of http-acme/submission/imap). */
  listenersCreated: z.array(z.string()),
  /** Free-form per-step notes (skip reasons, errors that didn't abort the tick). */
  notes: z.array(z.string()),
  /** Convenience: true when no Stalwart state was changed. */
  noOp: z.boolean(),
});

export type StalwartReprovisionResponse = z.infer<typeof stalwartReprovisionResponseSchema>;

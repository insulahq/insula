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
  /** Operator-set mail hostname (null when unset). */
  mailHostname: z.string().nullable(),
  /** Stalwart Domain matched by EXACT name == hostname (the cert anchor). */
  matchedDomain: z.object({ name: z.string(), id: z.string() }).nullable(),
  /** Always null in the current architecture (no SAN map). Kept for compat. */
  sanKey: z.string().nullable(),
  /** True when SystemSettings.defaultHostname + defaultDomainId were patched. */
  defaultHostnameUpdated: z.boolean(),
  /** True when the Let's Encrypt AcmeProvider was created this run. */
  acmeProviderCreated: z.boolean(),
  /**
   * True when the cert-anchor Domain was created this run (was missing).
   * The reconciler auto-creates it because it's platform infra, not a
   * tenant decision (and there's no admin UI to add it manually).
   */
  certAnchorDomainCreated: z.boolean().default(false),
  /** True when matched Domain.certificateManagement was patched. */
  certManagementUpdated: z.boolean(),
  /** Names of NetworkListeners newly created (subset of http-acme/submission/imap). */
  listenersCreated: z.array(z.string()),
  /** True when AcmeRenewal task was fired (Stalwart-side idempotent). */
  acmeRenewalFired: z.boolean(),
  /** Free-form per-step notes (skip reasons, errors that didn't abort the tick). */
  notes: z.array(z.string()),
  /** True when no Stalwart state was changed. */
  noOp: z.boolean(),
});

export type StalwartReprovisionResponse = z.infer<typeof stalwartReprovisionResponseSchema>;

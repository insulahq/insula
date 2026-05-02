import { z } from 'zod';

/**
 * Operator-facing envelope a lifecycle hook returns on failure /
 * partial-success. Backend writes this into
 * client_lifecycle_hook_runs.last_error verbatim; frontend renders
 * each field via the lifecycle progress UI.
 *
 * Same shape as the broader OperatorError envelope but narrower —
 * lifecycle hooks don't carry HTTP-status / code metadata since
 * they're not direct request handlers.
 */
export const lifecycleHookErrorEnvelopeSchema = z.object({
  /** One-line headline. Mandatory. */
  title: z.string(),
  /** Sentence-or-two human-readable detail. */
  detail: z.string().optional(),
  /** Step-by-step suggestions the operator can follow. */
  remediation: z.array(z.string()).optional(),
  /** Raw error/stack — surfaced behind a "show raw" expander. */
  raw: z.string().optional(),
});
export type LifecycleHookErrorEnvelope = z.infer<typeof lifecycleHookErrorEnvelopeSchema>;

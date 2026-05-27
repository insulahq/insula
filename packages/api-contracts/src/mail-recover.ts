import { z } from 'zod';

/**
 * Mail Recovery API — operator action when mail-stack is in a broken
 * state (Pod stuck Pending / CrashLoopBackOff, OR PVC bound on a node
 * that doesn't match system_settings.mailActiveNode).
 *
 * Distinct from regular migration: assumes source data may already be
 * lost (no fresh backup, no same-node check), force-deletes stuck pods
 * on source, and triggers the standard PVC swap + scale-up + restore
 * sequence with the operator-chosen target.
 */

export const mailRecoveryStatusSchema = z.object({
  state: z.enum(['healthy', 'broken', 'unknown']),
  /** Operator-facing explanation when state !== 'healthy'. */
  reason: z.string().nullable(),
  /** Node where mail-stack-data PVC is currently bound. */
  pvcNode: z.string().nullable(),
  /** Node system_settings.mailActiveNode points to. */
  expectedActiveNode: z.string().nullable(),
  /** Stalwart pod's current phase ('Running' | 'Pending' | ...). */
  podPhase: z.string().nullable(),
  /** Suggested recovery target (mailPrimaryNode preferred). */
  suggestedTargetNode: z.string().nullable(),
});
export type MailRecoveryStatus = z.infer<typeof mailRecoveryStatusSchema>;

export const mailRecoveryStatusResponseSchema = z.object({
  status: mailRecoveryStatusSchema,
});
export type MailRecoveryStatusResponse = z.infer<typeof mailRecoveryStatusResponseSchema>;

export const mailRecoverRequestSchema = z.object({
  targetNode: z.string()
    .min(1).max(253)
    .regex(/^[a-z0-9]([a-z0-9-.]{0,251}[a-z0-9])?$/, 'must be a valid RFC 1123 hostname'),
  /**
   * Type-to-confirm — operator types the targetNode value. UI enforces
   * primarily; server-side check is a backstop.
   */
  confirmTargetNode: z.string().min(1),
});
export type MailRecoverRequest = z.infer<typeof mailRecoverRequestSchema>;

export const mailRecoverResponseSchema = z.object({
  /** Migration run ID — operator polls /admin/mail/migrate/:runId for progress. */
  runId: z.string().uuid(),
  taskId: z.string().nullable(),
});
export type MailRecoverResponse = z.infer<typeof mailRecoverResponseSchema>;

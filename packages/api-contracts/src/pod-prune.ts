import { z } from 'zod';

/**
 * Pruning dead pod records.
 *
 * A pod in a terminal phase keeps its full object — spec, labels, container
 * statuses — and Kubernetes only garbage-collects terminal pods past
 * `--terminated-pod-gc-threshold`, which defaults to 12500. In practice that
 * means never: one graceful node reboot on a small cluster leaves a few dozen,
 * and nothing removes them. They hold no CPU or memory and no scheduling
 * capacity, but they DO hold their container log directory on the node, and any
 * code that reads pods from a list sees a workload that is not there.
 *
 * Production 2026-09-15: 43 such records from a single node shutdown held
 * ~102 MB of logs and inflated ten tenants' reported memory by 1.953Gi.
 */

/** Ceiling on the retention window an operator can configure. */
export const MAX_AUTO_PRUNE_DAYS = 365;

/** Default retention before a dead pod record is swept. */
export const DEFAULT_AUTO_PRUNE_DAYS = 30;

export const podPrunePolicySchema = z.object({
  /**
   * Age in days after which a dead pod record is swept automatically.
   * `0` disables auto-pruning entirely; the manual action still works.
   */
  autoPruneDays: z.number().int().min(0).max(MAX_AUTO_PRUNE_DAYS),
});
export type PodPrunePolicy = z.infer<typeof podPrunePolicySchema>;

export const podPruneRequestSchema = z.object({
  /**
   * Only prune records older than this many days. Omitted or 0 means "every
   * dead record", which is what the manual button sends — an operator pressing
   * "Prune Dead Pods" means now, not eventually.
   */
  olderThanDays: z.number().int().min(0).max(MAX_AUTO_PRUNE_DAYS).optional(),
}).strict();
export type PodPruneRequest = z.infer<typeof podPruneRequestSchema>;

/** Why a dead record was left in place. */
export const podPruneSkipReasonSchema = z.enum([
  /** Younger than the requested window. */
  'too_young',
  /**
   * Owned by a Job that has not finished. Deleting a succeeded pod of a Job
   * that still wants completions makes the Job run it AGAIN — the one case
   * where pruning is not merely tidy-up.
   */
  'job_still_active',
  /** The delete call itself failed; the record is still there. */
  'delete_failed',
]);
export type PodPruneSkipReason = z.infer<typeof podPruneSkipReasonSchema>;

export const podPruneEntrySchema = z.object({
  namespace: z.string(),
  name: z.string(),
  phase: z.string(),
  /** ISO timestamp the pod's last container finished, when known. */
  finishedAt: z.string().nullable(),
  ageDays: z.number(),
});
export type PodPruneEntry = z.infer<typeof podPruneEntrySchema>;

export const podPruneResultSchema = z.object({
  /** Dead records considered. */
  scanned: z.number().int().nonnegative(),
  pruned: z.array(podPruneEntrySchema),
  skipped: z.array(podPruneEntrySchema.extend({ reason: podPruneSkipReasonSchema })),
  /** Operator-facing summary; always populated. */
  message: z.string(),
});
export type PodPruneResult = z.infer<typeof podPruneResultSchema>;

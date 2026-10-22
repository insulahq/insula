import { z } from 'zod';

/**
 * Mail-stack-standby-replicate per-node freshness reports.
 *
 * GET /admin/mail/standby-reports
 *
 * Source of truth: the mail-stack-standby-replicate DaemonSet POSTs
 * one report per successful 5-min rsync iteration to
 * POST /internal/mail/standby-replicate-report (PLATFORM_INTERNAL_SECRET
 * bearer). Only the latest report per node is retained, and only the
 * nodes that are standbys now are listed.
 */

export const standbyReportSchema = z.object({
  /** k8s node hostname (spec.nodeName from downwardAPI on the DaemonSet pod). */
  node: z.string().min(1).max(253),
  /** Size in bytes of /standby-data on this node after the latest rsync. */
  sizeBytes: z.number().int().nonnegative(),
  /** File count under /standby-data (excludes lost+found). */
  fileCount: z.number().int().nonnegative(),
  /** Wall-clock seconds the last rsync took. */
  durationSeconds: z.number().int().nonnegative(),
  /** ISO-8601 datetime when the report landed at platform-api. */
  reportedAt: z.string().datetime(),
  /** Seconds since reportedAt (server-computed for stable display). */
  ageSeconds: z.number().int().nonnegative(),
});

export type StandbyReport = z.infer<typeof standbyReportSchema>;

export const standbyReportsResponseSchema = z.object({
  /** The nodes that are standbys now — not every node that ever reported. */
  reports: z.array(standbyReportSchema),
  /**
   * Standby nodes still making their first copy (a standby move labels a new
   * node, which copies the whole store before it reports), with the time each
   * became a standby. Absent from an older backend.
   */
  preparing: z.array(z.object({
    node: z.string(),
    since: z.string(),
    /**
     * `preparing` while the copy runs; `not_running` when its copier is not
     * running ten minutes on, `overdue` when not finished after six hours —
     * the standby check fails for both. Absent from an older backend.
     */
    state: z.enum(['preparing', 'not_running', 'overdue']).optional(),
    /** The Task Center task tracking this first copy, when there is one. */
    taskId: z.string().uuid().optional(),
    /** How far the copy is (0–100), once its copier has reported progress. */
    copyPercent: z.number().int().min(0).max(100).optional(),
  })).optional(),
});

export type StandbyReportsResponse = z.infer<typeof standbyReportsResponseSchema>;

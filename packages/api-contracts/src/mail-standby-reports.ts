import { z } from 'zod';

/**
 * Mail-stack-standby-replicate per-node freshness reports.
 *
 * GET /admin/mail/standby-reports
 *
 * Source of truth: the mail-stack-standby-replicate DaemonSet POSTs
 * one report per successful 5-min rsync iteration to
 * POST /internal/mail/standby-replicate-report (PLATFORM_INTERNAL_SECRET
 * bearer). Only the latest report per node is retained.
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
  reports: z.array(standbyReportSchema),
});

export type StandbyReportsResponse = z.infer<typeof standbyReportsResponseSchema>;

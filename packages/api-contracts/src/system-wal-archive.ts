import { z } from 'zod';

// System Backup Phase 4 — WAL archive runtime config.
// 2026-05-24 (Phase 6): WAL target = SYSTEM shim binding. The
// operator picks the target ONCE on /backups/system?tab=routing;
// this endpoint no longer takes a separate `targetConfigId`. Any
// upstream storage type (S3 / CIFS / NFS / SFTP) works because
// barman-cloud writes go through backup-rclone-shim's local S3
// endpoint regardless of upstream protocol.

// Same DNS-label validator as pg-dump. Postgres database name isn't
// in scope here (WAL is at cluster level, not per-DB).
const dnsLabelSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'must be a lowercase DNS label');

// Postgres archive_timeout accepted format: positive integer + unit
// (s|min|h). Restricted to short presets at the UI; backend enforces
// the regex below.
export const archiveTimeoutSchema = z
  .string()
  .regex(/^[0-9]+(s|min|h)$/, 'must look like 30s / 5min / 1h')
  .default('5min');

// 6-field cron expression (CNPG ScheduledBackup uses
// github.com/robfig/cron/v3 with seconds-precision parsing).
// Five-field UNIX cron is *not* accepted by CNPG. We surface UI
// presets that map to known-good 6-field strings; advanced users
// can pass any 6-field cron.
export const baseBackupScheduleSchema = z
  .string()
  .regex(
    /^(\S+\s+){5}\S+$/,
    'must be a 6-field cron expression (seconds minutes hours dom month dow)',
  );

export const walArchiveEnableRequestSchema = z.object({
  clusterNamespace: dnsLabelSchema,
  clusterName: dnsLabelSchema,
  retentionDays: z.number().int().min(1).max(3650).default(30),
  archiveTimeout: archiveTimeoutSchema.optional(),
  // null OR omitted means "no base backup ScheduledBackup CR" — the
  // operator just gets WAL streaming. Setting it both creates the CR
  // and makes pure-S3 cold restore self-sufficient.
  baseBackupSchedule: baseBackupScheduleSchema.nullable().optional(),
  // 2026-05-24 (Phase 6): baseBackupRetentionDays was vestigial — stored
  // but never applied to any CR. WAL retention (retentionDays above) is
  // the only retention setting that actually controls the archive.
  // Removed from the contract; the DB column stays for back-compat with
  // pre-Phase-6 rows.
}).strict(); // .strict() rejects unknown fields. Catches pre-Phase-6
// super_admin scripts still sending targetConfigId or
// baseBackupRetentionDays — better explicit 400 than silent strip.
export type WalArchiveEnableRequest = z.infer<typeof walArchiveEnableRequestSchema>;

export const walArchiveDisableRequestSchema = z.object({
  clusterNamespace: dnsLabelSchema,
  clusterName: dnsLabelSchema,
});
export type WalArchiveDisableRequest = z.infer<typeof walArchiveDisableRequestSchema>;

// ── Phase 7a (2026-05-24): split WAL streaming vs Scheduled Backups ─────
//
// Operators can now enable/disable each independently. Both routes
// share the cluster identifier; the per-feature settings differ. Both
// use .strict() to reject unknown fields and surface the dropped
// pre-Phase-6 targetConfigId / baseBackupRetentionDays explicitly.





// One entry per cluster in the GET /clusters list. Combines the DB
// state row (operator intent) with a snapshot of the CNPG CR's
// `.status` (cluster-reported truth: last archived WAL, archiver
// errors). When `enabled=false`, `state` is null.
/**
 * CNPG's own `archive_timeout` default. It applies the moment the barman-cloud
 * plugin is attached and nobody set an explicit value — so it is the real
 * recovery-point window in that state, not "unset".
 */
export const CNPG_DEFAULT_ARCHIVE_TIMEOUT = '5min';

export const walArchiveClusterSchema = z.object({
  clusterNamespace: z.string(),
  clusterName: z.string(),
  /**
   * The operator INTENT flag: a state row exists and the plugin is attached.
   * Kept for back-compat — read `walArchivingActive` for what is actually
   * happening and `walArchivingSource` for why.
   */
  enabled: z.boolean(),
  /**
   * Whether WAL is REALLY being shipped off-site right now — the barman-cloud
   * plugin entry is present on the Cluster CR. Production 2026-09-11 had this
   * true with WAL streaming never enabled: enabling scheduled base backups is
   * enough, and the UI showed "not enabled" while a segment went off-site
   * every 5 minutes.
   */
  walArchivingActive: z.boolean(),
  /**
   * The `archive_timeout` actually in force: the operator's explicit value when
   * WAL streaming is on, otherwise CNPG's default while archiving is active,
   * otherwise null. This is the RPO ceiling on an idle database.
   */
  effectiveArchiveTimeout: z.string().nullable(),
  state: z.object({
    targetConfigId: z.string(),
    targetName: z.string().nullable(),
    retentionDays: z.number().int(),
    destinationPath: z.string(),
    enabledAt: z.string().datetime(),
    archiveTimeout: z.string().nullable(),
    baseBackupSchedule: z.string().nullable(),
    /** @deprecated Phase 6 (2026-05-24) — vestigial; the UI no longer
     *  surfaces it. Kept for back-compat with rows written pre-Phase-6. */
    baseBackupRetentionDays: z.number().int().nullable(),
    // ScheduledBackup CR live status (null when no SB exists).
    baseBackupStatus: z.object({
      lastScheduleTime: z.string().nullable(),
      nextScheduleTime: z.string().nullable(),
    }).nullable(),
  }).nullable(),
  // Operator-visible status surfaced from CNPG CR's .status. Best-
  // effort — null when not yet populated by CNPG.
  status: z.object({
    firstRecoverabilityPoint: z.string().nullable(),
    /**
     * Real values from `pg_stat_archiver` on the cluster itself where we can
     * reach it. Before 2026-09-11 these were SYNTHESISED from the
     * ContinuousArchiving condition's `lastTransitionTime` — on production
     * that read 2026-08-12 while WAL was being archived every five minutes,
     * i.e. the card presented a month-old timestamp as "last WAL archived".
     */
    lastArchivedWal: z.string().nullable(),
    lastArchivedWalTime: z.string().nullable(),
    lastFailedArchiveTime: z.string().nullable(),
    lastFailedArchiveError: z.string().nullable(),
    /**
     * Cumulative counters from `pg_stat_archiver` since `statsResetAt` (null
     * when unavailable). `failedCount` is a LIFETIME total — a non-zero value
     * says nothing about whether archiving is failing now; `lastFailedArchiveTime`
     * is only populated when nothing has been archived since that failure.
     */
    archivedCount: z.number().int().nullable(),
    failedCount: z.number().int().nullable(),
    statsResetAt: z.string().nullable(),
    /** CNPG's ContinuousArchiving condition — health, NOT recency. */
    archivingHealthySince: z.string().nullable(),
  }).nullable(),
});
export type WalArchiveCluster = z.infer<typeof walArchiveClusterSchema>;

export const walArchiveListResponseSchema = z.array(walArchiveClusterSchema);
export type WalArchiveListResponse = z.infer<typeof walArchiveListResponseSchema>;

export const walArchiveActionResponseSchema = z.object({
  clusterNamespace: z.string(),
  clusterName: z.string(),
  enabled: z.boolean(),
  destinationPath: z.string().nullable(),
});
export type WalArchiveActionResponse = z.infer<typeof walArchiveActionResponseSchema>;

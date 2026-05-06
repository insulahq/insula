import { z } from 'zod';

/**
 * CNPG Backup CR health snapshot — one entry per CNPG Cluster CR.
 *
 * Surfaced on admin pages (Email Management for mail-pg, Storage Settings
 * for platform/postgres) so operators see backup failures without having
 * to run `kubectl get backup.postgresql.cnpg.io`. Phase 2A.2 of the mail-
 * subsystem hardening work — closes the gap that let
 * mail-pg-daily-20260505031500 fail unnoticed.
 */
export const cnpgBackupPhaseSchema = z.enum([
  'completed',
  'failed',
  'running',
  'started',
  'pending',
  'unknown',
]);
export type CnpgBackupPhase = z.infer<typeof cnpgBackupPhaseSchema>;

export const cnpgBackupRecordSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  clusterName: z.string(),
  method: z.string(),
  phase: cnpgBackupPhaseSchema,
  /** ISO-8601 timestamp; null if Backup hasn't started yet (rare). */
  startedAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type CnpgBackupRecord = z.infer<typeof cnpgBackupRecordSchema>;

export const cnpgClusterHealthStateSchema = z.enum([
  /** Last attempt completed, last success < 24h ago. */
  'healthy',
  /** Last attempt completed but > 24h ago — schedule may be misconfigured. */
  'stale',
  /** Last attempt failed (more recent than any success). */
  'failing',
  /** No Backup CRs observed for this cluster yet. */
  'never_run',
  /** ScheduledBackup CRs exist but cluster.spec.backup is unset. */
  'no_backup_config',
]);
export type CnpgClusterHealthState = z.infer<typeof cnpgClusterHealthStateSchema>;

export const cnpgClusterBackupHealthSchema = z.object({
  clusterName: z.string(),
  namespace: z.string(),
  state: cnpgClusterHealthStateSchema,
  lastSuccessfulBackup: cnpgBackupRecordSchema.nullable(),
  mostRecentFailure: cnpgBackupRecordSchema.nullable(),
  /** Seconds since the last successful backup; null if never run. */
  lastSuccessSecondsAgo: z.number().int().nullable(),
  /** Names of ScheduledBackup CRs targeting this cluster. */
  scheduledBackups: z.array(z.string()),
  /** True if cluster.spec.backup section is set (barmanObjectStore configured). */
  clusterHasBackupSpec: z.boolean(),
});
export type CnpgClusterBackupHealth = z.infer<typeof cnpgClusterBackupHealthSchema>;

/**
 * Response envelope for `GET /api/v1/admin/cnpg-backup-health`.
 */
export const cnpgBackupHealthResponseSchema = z.object({
  data: z.array(cnpgClusterBackupHealthSchema),
});
export type CnpgBackupHealthResponse = z.infer<typeof cnpgBackupHealthResponseSchema>;

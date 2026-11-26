/**
 * Per-database backup status — the last attempt and the last good backup of
 * every tenant database, as recorded after each tenant bundle. Each list is a
 * keyset page in the standard envelope (`data: [...]`, `pagination`).
 *
 *   GET /api/v1/tenant/backups/databases                 (tenant panel)
 *   GET /api/v1/admin/tenants/:tenantId/database-backups (admin, one tenant)
 *   GET /api/v1/admin/database-backups/overdue           (admin, fleet)
 */

import { z } from 'zod';

export const databaseBackupLastStatusSchema = z.enum(['dumped', 'degraded', 'failed']);
export type DatabaseBackupLastStatus = z.infer<typeof databaseBackupLastStatusSchema>;

/**
 * What kind of failure the last attempt was — all a tenant is told. Dump
 * errors are written by database clients and Kubernetes and can carry
 * addresses, account names and paths, so the text itself is operator-only.
 */
export const databaseBackupErrorKindSchema = z.enum([
  'tool_missing', 'volume_full', 'access_denied', 'timed_out', 'not_running',
  'interrupted', 'not_kept', 'did_not_run', 'other',
]);
export type DatabaseBackupErrorKind = z.infer<typeof databaseBackupErrorKindSchema>;

/**
 * The database's instance: `stopped` (deliberately) or `removed` (deleted,
 * pending the next bundle's clean-up). Neither is judged overdue.
 */
export const databaseBackupInstanceStateSchema = z.enum(['active', 'stopped', 'removed']);
export type DatabaseBackupInstanceState = z.infer<typeof databaseBackupInstanceStateSchema>;

export const databaseBackupStatusSchema = z.object({
  /** The deployment id, or 'sqlite' for SQLite files on the tenant volume. */
  subjectKey: z.string(),
  deploymentId: z.string().nullable(),
  deploymentName: z.string(),
  /** 'mariadb' | 'mysql' | 'postgresql' | 'mongodb' | 'sqlite' | null. */
  engine: z.string().nullable(),
  /** The instance as a person reads it: "my-mariadb (MariaDB)", "SQLite files on the volume". */
  instanceLabel: z.string(),
  instanceState: databaseBackupInstanceStateSchema,
  /** The database name, the SQLite file's path, or a synthetic '(…)' entry. */
  databaseName: z.string(),
  /** The database as a person reads it — synthetic entries spelled out. */
  databaseLabel: z.string(),
  lastAttemptAt: z.string(),
  lastStatus: databaseBackupLastStatusSchema,
  /** Null when the last attempt was a good backup. */
  lastErrorKind: databaseBackupErrorKindSchema.nullable(),
  /** One fixed sentence for the kind. */
  lastErrorLabel: z.string().nullable(),
  /** The last good backup: a dump the bundle's files snapshot kept. Null = never. */
  lastSuccessAt: z.string().nullable(),
  lastSuccessSizeBytes: z.number().int().nonnegative().nullable(),
  /** No good backup in the latest scheduled run that has had time to finish (the sweep's verdict). */
  overdue: z.boolean(),
  overdueSince: z.string().nullable(),
});
export type DatabaseBackupStatus = z.infer<typeof databaseBackupStatusSchema>;

export const adminDatabaseBackupStatusSchema = databaseBackupStatusSchema.extend({
  /** The last attempt's error text (operator only). */
  lastError: z.string().nullable(),
  tenantId: z.string(),
  tenantName: z.string(),
});
export type AdminDatabaseBackupStatus = z.infer<typeof adminDatabaseBackupStatusSchema>;

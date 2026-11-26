/**
 * Per-database backup status — the last attempt and the last good backup of
 * every tenant database, as recorded after each tenant bundle.
 *
 *   GET /api/v1/tenant/backups/databases                 (tenant panel)
 *   GET /api/v1/admin/tenants/:tenantId/database-backups (admin, one tenant)
 *   GET /api/v1/admin/database-backups/overdue           (admin, fleet)
 */

import { z } from 'zod';

export const databaseBackupLastStatusSchema = z.enum(['dumped', 'degraded', 'failed']);
export type DatabaseBackupLastStatus = z.infer<typeof databaseBackupLastStatusSchema>;

export const databaseBackupStatusSchema = z.object({
  /** The deployment id, or 'sqlite' for SQLite files on the tenant volume. */
  subjectKey: z.string(),
  deploymentId: z.string().nullable(),
  deploymentName: z.string(),
  /** 'mariadb' | 'mysql' | 'postgresql' | 'mongodb' | 'sqlite' | null. */
  engine: z.string().nullable(),
  /** The instance as a person reads it: "my-mariadb (MariaDB)", "SQLite files on the volume". */
  instanceLabel: z.string(),
  /** The database name, the SQLite file's path, or '(deployment)' / '(SQLite discovery)'. */
  databaseName: z.string(),
  /** The database as a person reads it — synthetic entries spelled out. */
  databaseLabel: z.string(),
  lastAttemptAt: z.string(),
  lastStatus: databaseBackupLastStatusSchema,
  /** Why the last attempt was not a good backup; null when it was. */
  lastError: z.string().nullable(),
  /** The last good backup: a dump the bundle's files snapshot kept. Null = never. */
  lastSuccessAt: z.string().nullable(),
  lastSuccessSizeBytes: z.number().int().nonnegative().nullable(),
  /** No good backup for longer than the schedule allows (the sweep's verdict). */
  overdue: z.boolean(),
  overdueSince: z.string().nullable(),
});
export type DatabaseBackupStatus = z.infer<typeof databaseBackupStatusSchema>;

export const adminDatabaseBackupStatusSchema = databaseBackupStatusSchema.extend({
  tenantId: z.string(),
  tenantName: z.string(),
});
export type AdminDatabaseBackupStatus = z.infer<typeof adminDatabaseBackupStatusSchema>;

export const databaseBackupStatusListSchema = z.object({
  databases: z.array(databaseBackupStatusSchema),
});
export type DatabaseBackupStatusList = z.infer<typeof databaseBackupStatusListSchema>;

export const adminDatabaseBackupStatusListSchema = z.object({
  databases: z.array(adminDatabaseBackupStatusSchema),
});
export type AdminDatabaseBackupStatusList = z.infer<typeof adminDatabaseBackupStatusListSchema>;

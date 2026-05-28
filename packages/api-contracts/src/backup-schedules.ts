import { z } from 'zod';
import { cronExpressionSchema } from './cron-expression.js';

// ─── Retention bounds (shared by row + PATCH) ──────────────────────────
//
// Practical caps so an operator typo can't request 999999 days of
// retention or schedule restic forget on a billion-snapshot history.
// 3650d = 10y is the same cap used elsewhere (system-wal-archive,
// tenant-bundles). 10000 count is well above any plausible use case
// at the snapshot-every-2-min cadence (would need ~14 days of full
// history before forget starts dropping things).
const RETENTION_DAYS_MAX = 3650;
const RETENTION_COUNT_MAX = 10000;

/**
 * Phase A.1 of the backup UI consolidation — uniform schedule shape
 * across all subsystems. The /admin/backups/schedules CRUD owns the
 * strict-gate: `enabled=true` is refused until the snapshot class
 * for this subsystem has at least one target assigned.
 *
 *   GET   /admin/backups/schedules
 *   GET   /admin/backups/schedules/:subsystem
 *   PATCH /admin/backups/schedules/:subsystem
 */

// ─── Subsystem enum ────────────────────────────────────────────────────
//
// Seeded by migration 0011. Free-form on the DB side so new
// subsystems can land without a schema migration, but the API contract
// pins the four known producers so frontends + tests get an enum.

export const backupScheduleSubsystemEnum = z.enum([
  'mail',                // restic upload — gates on system_mail target
  'tenant_bundle',       // nightly Plesk-style bundles — gates on tenant_bundle target
  'system_pitr',         // postgres base-backup cron — gates on system_backup target
  'longhorn_recurring',  // platform-wide Longhorn RecurringJob default
]);
export type BackupScheduleSubsystem = z.infer<typeof backupScheduleSubsystemEnum>;

// ─── Row shape ─────────────────────────────────────────────────────────

export const backupScheduleSchema = z.object({
  subsystem: z.string().min(1).max(64),
  enabled: z.boolean(),
  /** Strictly-validated 5-field cron expression. Null for subsystems with no cron. */
  cronExpression: cronExpressionSchema.nullable(),
  /** Days to keep, capped at 10y to prevent typos. Null = no day-based retention. */
  retentionDays: z.number().int().nonnegative().max(RETENTION_DAYS_MAX).nullable(),
  /** restic --keep-last count, capped at 10000. Null = no count-based retention. */
  retentionCount: z.number().int().nonnegative().max(RETENTION_COUNT_MAX).nullable(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().nullable(),
  /** When enabled=false, which class needs a target before enable is allowed. */
  gatedByClass: z.string().nullable(),
  /** Convenience: true when the gated class already has ≥1 assignment. */
  gateSatisfied: z.boolean(),
});
export type BackupScheduleRow = z.infer<typeof backupScheduleSchema>;

// ─── List response ─────────────────────────────────────────────────────

// NB: tenant-bundles.ts already exports `listBackupSchedulesResponseSchema`
// for a different concept (per-tenant bundle schedule). Use a distinct
// name here to avoid the re-export collision in index.ts.
export const listSubsystemBackupSchedulesResponseSchema = z.object({
  schedules: z.array(backupScheduleSchema),
});
export type ListSubsystemBackupSchedulesResponse = z.infer<typeof listSubsystemBackupSchedulesResponseSchema>;

// ─── PATCH input ───────────────────────────────────────────────────────

export const updateBackupScheduleSchema = z.object({
  enabled: z.boolean().optional(),
  cronExpression: cronExpressionSchema.nullable().optional(),
  retentionDays: z.number().int().nonnegative().max(RETENTION_DAYS_MAX).nullable().optional(),
  retentionCount: z.number().int().nonnegative().max(RETENTION_COUNT_MAX).nullable().optional(),
}).refine(
  // Reject "both zero" — restic forget requires at least one --keep-*
  // flag, and an operator setting both to 0 effectively means "never
  // forget" which is rarely intended (snapshot-upload.sh falls back to
  // --keep-last 48 in that case, masking the bad setting). Surface the
  // intent error at the API.
  (data) => {
    if (data.retentionDays === 0 && data.retentionCount === 0) return false;
    return true;
  },
  {
    message: 'retentionDays and retentionCount cannot both be 0 — restic forget needs at least one to keep snapshots',
    path: ['retentionCount'],
  },
);
export type UpdateBackupScheduleInput = z.infer<typeof updateBackupScheduleSchema>;

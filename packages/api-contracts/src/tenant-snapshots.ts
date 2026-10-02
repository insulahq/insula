import { z } from 'zod';
import { operatorErrorSchema } from './operator-error.js';

/**
 * Tenant on-server volume snapshots (Longhorn CSI VolumeSnapshot, type=snap).
 *
 * Short-term PVC recovery points the tenant manages from the tenant panel —
 * on-server only (no off-site upload) and auto-expiring after the admin-set
 * `snapshot_expiry_hours`. NOT a backup: real backups are the off-site tenant
 * bundles (restic). The single source of truth for these schemas; backend
 * validates with them and the tenant panel infers its types from them.
 */

export const tenantSnapshotStatusSchema = z.enum(['creating', 'ready', 'error', 'deleting']);
export type TenantSnapshotStatus = z.infer<typeof tenantSnapshotStatusSchema>;

export const tenantSnapshotSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  label: z.string().nullable(),
  status: tenantSnapshotStatusSchema,
  /** Provisioned size of the snapshotted volume (the VolumeSnapshot's
   *  restoreSize — what a restore gives back), in bytes. 0 while creating. */
  sizeBytes: z.number(),
  /**
   * Bytes this snapshot actually holds on the server: Longhorn's per-snapshot
   * `status.size` — the data written to the volume since the previous snapshot
   * of it (the first snapshot of a volume holds everything written so far).
   *
   * `null` means NOT MEASURED — still creating, taken before data sizes were
   * tracked, or the storage system did not report it on this request. A real
   * `0` (nothing changed since the previous snapshot) stays `0`; the UI must
   * render the two differently.
   */
  dataSizeBytes: z.number().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  readyAt: z.string().nullable(),
  expiresAt: z.string(),
});
export type TenantSnapshot = z.infer<typeof tenantSnapshotSchema>;

/** POST /api/v1/tenants/:tenantId/snapshots */
export const createTenantSnapshotSchema = z.object({
  label: z.string().trim().max(200).optional(),
});
export type CreateTenantSnapshotInput = z.infer<typeof createTenantSnapshotSchema>;

/** GET /api/v1/tenants/:tenantId/snapshots — list + the active retention window. */
export const listTenantSnapshotsResponseSchema = z.object({
  snapshots: z.array(tenantSnapshotSchema),
  /** Admin-configured retention; the UI shows "auto-deletes after N hours". */
  expiryHours: z.number(),
});
export type ListTenantSnapshotsResponse = z.infer<typeof listTenantSnapshotsResponseSchema>;

/** POST /tenants/:tenantId/snapshots/:snapshotId/restore — starts a DESTRUCTIVE
 *  in-place revert (replaces live files with the snapshot's); returns the
 *  storage operation id to poll. */
export const startSnapshotRestoreResponseSchema = z.object({
  operationId: z.string(),
});
export type StartSnapshotRestoreResponse = z.infer<typeof startSnapshotRestoreResponseSchema>;

/**
 * The steps of an in-place snapshot restore, in the order they run.
 * `recover` is not part of the normal run — it appears only after a failure,
 * when the engine starts the workloads it stopped again.
 */
export const SNAPSHOT_RESTORE_STEP_KEYS = [
  'quiesce',
  'wait-detach',
  'attach-maintenance',
  'wait-maintenance',
  'revert',
  'detach-maintenance',
  'unquiesce',
  'recover',
] as const;
export const snapshotRestoreStepKeySchema = z.enum(SNAPSHOT_RESTORE_STEP_KEYS);
export type SnapshotRestoreStepKey = z.infer<typeof snapshotRestoreStepKeySchema>;

/** `skipped` = the restore ended (failed) before this step could run. */
export const snapshotRestoreStepStateSchema = z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped']);
export type SnapshotRestoreStepState = z.infer<typeof snapshotRestoreStepStateSchema>;

export const snapshotRestoreStepSchema = z.object({
  key: snapshotRestoreStepKeySchema,
  /** Human label, rendered as-is by both panels. */
  label: z.string(),
  state: snapshotRestoreStepStateSchema,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** Wall time of a finished step; null while pending/running/skipped. */
  elapsedMs: z.number().nullable(),
  /** Operator diagnostic (Longhorn node, final volume state). Always null for
   *  tenant-panel callers — it names cluster internals. */
  detail: z.string().nullable(),
});
export type SnapshotRestoreStep = z.infer<typeof snapshotRestoreStepSchema>;

/** Collapsed outcome the progress UI branches on. */
export const snapshotRestoreOutcomeSchema = z.enum(['running', 'succeeded', 'failed']);
export type SnapshotRestoreOutcome = z.infer<typeof snapshotRestoreOutcomeSchema>;

/** GET /tenants/:tenantId/snapshots/restore-status/:operationId — poll target
 *  for the restore. Tenant-scoped: a caller only ever sees an operation that
 *  belongs to the tenant in the path, and tenant-panel callers get the
 *  sanitized view (no step `detail`, no raw upstream error). */
export const snapshotRestoreStatusSchema = z.object({
  operationId: z.string(),
  /** Raw storage-lifecycle state: quiescing → restoring → unquiescing → idle | failed. */
  state: z.string(),
  outcome: snapshotRestoreOutcomeSchema,
  progressPct: z.number(),
  progressMessage: z.string().nullable(),
  /** Failure text for this caller: the raw engine error for operators, a
   *  plain-language sentence for tenant-panel callers. */
  lastError: z.string().nullable(),
  /** Structured failure for <ErrorPanel>; null unless outcome is `failed`. */
  error: operatorErrorSchema.nullable(),
  /** The label the snapshot was given, when it has one. */
  snapshotLabel: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  /** Step timeline in run order. Empty for a restore started before step
   *  tracking existed — the UI falls back to the progress bar. */
  steps: z.array(snapshotRestoreStepSchema),
});
export type SnapshotRestoreStatus = z.infer<typeof snapshotRestoreStatusSchema>;

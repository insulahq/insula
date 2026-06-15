import { z } from 'zod';

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
  /** restoreSize in bytes once `ready`; 0 while creating. */
  sizeBytes: z.number(),
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
 *  PVC swap (replaces live files with the snapshot's); returns the storage
 *  operation id to poll. */
export const startSnapshotRestoreResponseSchema = z.object({
  operationId: z.string(),
});
export type StartSnapshotRestoreResponse = z.infer<typeof startSnapshotRestoreResponseSchema>;

/** GET /tenants/:tenantId/snapshots/restore-status/:operationId — poll target
 *  for the restore. `state` runs quiescing→replacing→restoring→unquiescing→idle
 *  (or `failed`). */
export const snapshotRestoreStatusSchema = z.object({
  operationId: z.string(),
  state: z.string(),
  progressPct: z.number(),
  progressMessage: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type SnapshotRestoreStatus = z.infer<typeof snapshotRestoreStatusSchema>;

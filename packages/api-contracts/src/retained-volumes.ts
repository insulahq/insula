import { z } from 'zod';

// ─── Retained-volume restore ─────────────────────────────────────────────────
//
// Admin-driven restore of a tenant PVC FROM a retained (Released, detached)
// Longhorn volume — the old volume left behind by a destructive shrink when a
// manual snapshot was taken first (longhorn-tenant SC is reclaimPolicy: Retain).
// See docs/roadmap/RETAINED_VOLUME_RESTORE.md.

/** One restorable Longhorn snapshot living on a retained volume. */
export const retainedSnapshotSchema = z.object({
  /** The `snapshots.longhorn.io` CR name — what snapshotRevert reverts to. */
  name: z.string(),
  /** RFC3339 creation time from the snapshot status, or null if unknown. */
  createdAt: z.string().nullable(),
  /** Snapshot size in bytes (0 when Longhorn has not reported it yet). */
  sizeBytes: z.number().int().nonnegative(),
  readyToUse: z.boolean(),
});
export type RetainedSnapshot = z.infer<typeof retainedSnapshotSchema>;

/** A detached, Released Longhorn volume that previously backed a tenant PVC. */
export const retainedVolumeSchema = z.object({
  pvName: z.string(),
  longhornVolumeName: z.string(),
  /** Capacity in bytes (from the PV, falling back to the Longhorn volume). */
  sizeBytes: z.number().int().nonnegative(),
  /** When the PV became Released (best-effort, from status), or null. */
  releasedAt: z.string().nullable(),
  /** Restorable snapshots on this volume, newest first. Always ≥1. */
  snapshots: z.array(retainedSnapshotSchema),
});
export type RetainedVolume = z.infer<typeof retainedVolumeSchema>;

export const retainedVolumesResponseSchema = z.object({
  data: z.array(retainedVolumeSchema),
});
export type RetainedVolumesResponse = z.infer<typeof retainedVolumesResponseSchema>;

/** Body for POST /admin/tenants/:id/storage/restore-retained. */
export const restoreRetainedRequestSchema = z.object({
  /** The retained PV to restore from (from the retained-volumes list). */
  pvName: z.string().min(1),
  /** The Longhorn snapshot on that volume to revert to. */
  snapshotName: z.string().min(1),
});
export type RestoreRetainedRequest = z.infer<typeof restoreRetainedRequestSchema>;

export const restoreRetainedResponseSchema = z.object({
  data: z.object({ operationId: z.string() }),
});
export type RestoreRetainedResponse = z.infer<typeof restoreRetainedResponseSchema>;

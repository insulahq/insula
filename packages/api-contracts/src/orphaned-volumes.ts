import { z } from 'zod';

// ─── Orphaned Volumes ────────────────────────────────────────────────────────

/**
 * Reasons a Persistent Volume / Longhorn volume is classified as orphaned.
 *
 *  - namespace_deleted     The PV's claimRef.namespace is gone.
 *  - client_record_deleted Tenant namespace exists but no client row in DB.
 *  - pv_released_stale     Phase=Released for > stalePvThresholdDays.
 *  - longhorn_volume_unbound  Longhorn volume CR exists but no PV references it.
 */
export const orphanReasonSchema = z.enum([
  'namespace_deleted',
  'client_record_deleted',
  'pv_released_stale',
  'longhorn_volume_unbound',
]);
export type OrphanReason = z.infer<typeof orphanReasonSchema>;

export const orphanedVolumeEntrySchema = z.object({
  /** PV name when one exists; null for `longhorn_volume_unbound`. */
  pvName: z.string().nullable(),
  /** Longhorn volume name when one exists; null when the PV uses a
      different provisioner. The UI must hide the Snapshot button for
      rows where this is null. */
  longhornVolumeName: z.string().nullable(),
  namespace: z.string().nullable(),
  pvcName: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  /** Nodes currently holding a healthy replica. */
  nodes: z.array(z.string()).default([]),
  reason: orphanReasonSchema,
  /** Days since PV.status.lastTransitionTime; null when unknown. */
  ageDays: z.number().int().nonnegative().nullable(),
  /** Pre-resolved label: client company name OR "Platform System (<ns>)". */
  ownerLabel: z.string(),
});
export type OrphanedVolumeEntry = z.infer<typeof orphanedVolumeEntrySchema>;

export const orphanedVolumesReportSchema = z.object({
  orphans: z.array(orphanedVolumeEntrySchema),
  totalCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  stalePvThresholdDays: z.number().int().min(1),
});
export type OrphanedVolumesReport = z.infer<typeof orphanedVolumesReportSchema>;

export const orphanSnapshotResponseSchema = z.object({
  snapshotName: z.string(),
});
export type OrphanSnapshotResponse = z.infer<typeof orphanSnapshotResponseSchema>;

export const orphanDeleteResponseSchema = z.object({
  deletedPv: z.boolean(),
  deletedLonghornVolume: z.boolean(),
});
export type OrphanDeleteResponse = z.infer<typeof orphanDeleteResponseSchema>;

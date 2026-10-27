import { z } from 'zod';

// ─── GET /admin/tenants/:tenantId/archive ─────────────────────────────
//
// What an archived tenant's page shows: when it was archived, its archive
// bundle (the tenant's final full backup), how long that is kept, and whether
// "Restore archived tenant" can bring it back.

export const tenantArchiveBundleSchema = z.object({
  id: z.string(),
  createdAt: z.string().datetime(),
  sizeBytes: z.number().nonnegative(),
  /**
   * TRUE for an archive taken whole — files, databases, mailboxes with their
   * mail, configuration — which restore brings back in full. FALSE for one
   * from before: files only, and restore brings back the files.
   */
  whole: z.boolean(),
});

/** A node the restore could run on, and why it cannot when it cannot. */
export const tenantRestoreNodeSchema = z.object({
  name: z.string(),
  problem: z.string().nullable(),
});

/** Where the restored tenant comes back (backend tenant-archive/restore-placement.ts). */
export const tenantRestorePlacementSchema = z.object({
  pinnedNode: z.string().nullable(),
  storageTier: z.enum(['local', 'ha']),
  /** Why the pinned node cannot take the restore; null when it can, or there is no pin. */
  pinProblem: z.string().nullable(),
  nodes: z.array(tenantRestoreNodeSchema),
});

/** The backup target the archive bundle sits on. */
export const tenantArchiveTargetSchema = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * FALSE when tenant backups are bound to another target now: the restore
   * reads the archive through a temporary read-only shim for this one.
   */
  bound: z.boolean(),
});

export const tenantArchiveInfoSchema = z.object({
  archivedAt: z.string().datetime().nullable(),
  bundle: tenantArchiveBundleSchema.nullable(),
  /** When the archive expires and the tenant is deleted; null = never. */
  expiresAt: z.string().datetime().nullable(),
  restorable: z.boolean(),
  /** Why restore is not possible, when it is not. */
  notRestorableReason: z.string().nullable(),
  /** The logical size of the archive's files — the least a restored volume must hold. 0 = unknown. */
  filesBytes: z.number().nonnegative(),
  /** The tenant's storage size in GiB: the restored volume's default size. */
  storageGi: z.number().positive(),
  /** Null when the bundle names no target (bundles from before targets were recorded). */
  target: tenantArchiveTargetSchema.nullable(),
  placement: tenantRestorePlacementSchema.nullable(),
  /** The tenant's subscription end; a restored tenant is suspended, and reactivating one past it is refused. */
  subscriptionExpiresAt: z.string().datetime().nullable(),
});
export type TenantArchiveInfo = z.infer<typeof tenantArchiveInfoSchema>;
export type TenantRestorePlacement = z.infer<typeof tenantRestorePlacementSchema>;

// ─── POST /admin/tenants/:tenantId/storage/restore ────────────────────

export const restoreArchivedTenantRequestSchema = z.object({
  /** The restored volume's size in GiB (rounded to two decimals); default: the tenant's size. */
  newGi: z.number().positive().max(1000).optional(),
  /** The node to restore on; null = Auto; absent = the tenant's pinned node. */
  nodeName: z.string().min(1).max(253).nullable().optional(),
});
export type RestoreArchivedTenantRequest = z.infer<typeof restoreArchivedTenantRequestSchema>;

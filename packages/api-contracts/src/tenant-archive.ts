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

export const tenantArchiveInfoSchema = z.object({
  archivedAt: z.string().datetime().nullable(),
  bundle: tenantArchiveBundleSchema.nullable(),
  /** When the archive expires and the tenant is deleted; null = never. */
  expiresAt: z.string().datetime().nullable(),
  restorable: z.boolean(),
  /** Why restore is not possible, when it is not. */
  notRestorableReason: z.string().nullable(),
});
export type TenantArchiveInfo = z.infer<typeof tenantArchiveInfoSchema>;

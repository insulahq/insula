import { z } from 'zod';

/**
 * Recycle bin for the tenant file manager.
 *
 * Deletes move the payload to `/data/.trash` on the same PVC — an atomic
 * rename, so it is instant and consumes no extra space. It does, however,
 * keep counting against the tenant's storage quota until it expires or is
 * emptied. There is deliberately NO size cap: a size-driven auto-purge would
 * delete one person's files because someone else filled the bin. Transparency
 * is the control instead, which is why `trashBytes` rides along with every
 * disk-usage response and the UI must surface it.
 */

// ─── Trash Entry ─────────────────────────────────────────────────────────────

/**
 * `type` is what the sidecar OBSERVED on disk, not what it recorded when the
 * entry was created — the metadata lives on a PVC the tenant can write over
 * SFTP, so it is never the authority. `symlink` therefore appears here even
 * though nothing the platform trashes is created as one.
 */
export const trashEntryTypeSchema = z.enum(['file', 'directory', 'symlink']);

export const trashEntrySchema = z.object({
  id: z.string(),
  shard: z.string(),
  /** BASE-relative path the entry came from. `null` when the metadata file is
   *  missing — the payload is still listed and still restorable (to a fallback
   *  location), because the payload tree is the source of truth. */
  originalPath: z.string().nullable(),
  name: z.string(),
  type: trashEntryTypeSchema,
  /** `null` for a directory whose size probe timed out at deletion time. */
  sizeBytes: z.number().nullable(),
  deletedAt: z.string(),
  deletedBy: z.string().nullable(),
  /** `file-manager` (an explicit delete), `deployment` (a deployment's data
   *  folder), or `replaced` (displaced by an incidental overwrite). */
  origin: z.string(),
  /** For origin=replaced: which operation displaced it (rename/copy/upload/
   *  write/extract), so the bin can say WHY the entry is there. */
  replacedBy: z.string().optional(),
  deploymentName: z.string().optional(),
  orphaned: z.boolean(),
});

export type TrashEntry = z.infer<typeof trashEntrySchema>;

export const trashListResponseSchema = z.object({
  entries: z.array(trashEntrySchema),
  usedBytes: z.number(),
  usedFormatted: z.string(),
  /** Mirrors the platform retention setting so the UI can show a real
   *  "purged in N days" per entry rather than a hardcoded guess. */
  retentionDays: z.number().int().positive(),
});

export type TrashListResponse = z.infer<typeof trashListResponseSchema>;

// ─── Restore ─────────────────────────────────────────────────────────────────

/**
 * `overwrite` and `autoRename` are mutually exclusive; with neither, a restore
 * onto an occupied path returns 409 with the conflicting path rather than
 * silently clobbering whatever is there now.
 */
export const trashRestoreInputSchema = z.object({
  id: z.string().min(1),
  overwrite: z.boolean().optional().default(false),
  autoRename: z.boolean().optional().default(false),
}).refine(d => !(d.overwrite && d.autoRename), {
  message: 'overwrite and autoRename are mutually exclusive',
});

export type TrashRestoreInput = z.infer<typeof trashRestoreInputSchema>;

export const trashRestoreResultSchema = z.object({
  id: z.string(),
  restoredTo: z.string(),
  renamed: z.boolean(),
});

export type TrashRestoreResult = z.infer<typeof trashRestoreResultSchema>;

// ─── Purge ───────────────────────────────────────────────────────────────────

export const MAX_TRASH_PURGE_IDS = 1000;

/**
 * Exactly one selector must be supplied. `olderThanDays` is reserved for the
 * platform's own expiry sweep — it is NOT accepted from the tenant panel, which
 * may only purge explicit ids or empty the bin.
 */
export const trashPurgeInputSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(MAX_TRASH_PURGE_IDS).optional(),
  all: z.boolean().optional(),
}).refine(d => (d.ids !== undefined) !== (d.all === true), {
  message: 'Provide either ids or all:true, not both',
});

export type TrashPurgeInput = z.infer<typeof trashPurgeInputSchema>;

export const trashPurgeResultSchema = z.object({
  purged: z.number(),
  bytesFreed: z.number(),
  bytesFreedFormatted: z.string(),
  examined: z.number(),
  failed: z.array(z.object({ id: z.string(), error: z.string() })),
});

export type TrashPurgeResult = z.infer<typeof trashPurgeResultSchema>;

// ─── Retention setting (admin) ───────────────────────────────────────────────

/**
 * Bounds for `system_settings.file_trash_retention_days`, which is edited on
 * the admin Limits page alongside snapshotExpiryHours and
 * deletedTenantBundleRetentionDays.
 *
 * The minimum is 1 rather than 0 on purpose: a zero-day window would make every
 * delete effectively permanent while the UI still said "Move to Trash", which
 * is precisely the mismatch this feature exists to remove. Operators who want
 * no recovery should leave the bin on and use "Delete permanently".
 */
export const DEFAULT_TRASH_RETENTION_DAYS = 14;
export const MIN_TRASH_RETENTION_DAYS = 1;
export const MAX_TRASH_RETENTION_DAYS = 365;

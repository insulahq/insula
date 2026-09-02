import { z } from 'zod';

// ─── File Entry ──────────────────────────────────────────────────────────────

export const fileEntrySchema = z.object({
  name: z.string(),
  type: z.enum(['file', 'directory']),
  size: z.number(),
  modifiedAt: z.string().nullable(),
  permissions: z.string(),
  uid: z.number(),
  gid: z.number(),
  owner: z.string().optional(),
  group: z.string().optional(),
});

export type FileEntry = z.infer<typeof fileEntrySchema>;

// ─── List Directory ──────────────────────────────────────────────────────────

export const listDirectoryResponseSchema = z.object({
  path: z.string(),
  entries: z.array(fileEntrySchema),
});

export type ListDirectoryResponse = z.infer<typeof listDirectoryResponseSchema>;

// ─── Read File ───────────────────────────────────────────────────────────────

export const fileContentResponseSchema = z.object({
  path: z.string(),
  content: z.string(),
  size: z.number(),
  modifiedAt: z.string(),
});

export type FileContentResponse = z.infer<typeof fileContentResponseSchema>;

// ─── Write File ──────────────────────────────────────────────────────────────

export const writeFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export type WriteFileInput = z.infer<typeof writeFileInputSchema>;

// ─── Create Directory ────────────────────────────────────────────────────────

export const createDirectoryInputSchema = z.object({
  path: z.string().min(1),
});

export type CreateDirectoryInput = z.infer<typeof createDirectoryInputSchema>;

// ─── Rename / Move ───────────────────────────────────────────────────────────

export const renameInputSchema = z.object({
  oldPath: z.string().min(1),
  newPath: z.string().min(1),
});


export type RenameInput = z.infer<typeof renameInputSchema>;

// ─── Delete ──────────────────────────────────────────────────────────────────

/**
 * `permanent` opts OUT of the recycle bin.
 *
 * The default of `false` is load-bearing, not a style choice: an optional flag
 * with a default makes every un-updated call site silent, so the default must
 * be the SAFE branch. A caller that never learned about the trash therefore
 * produces a recoverable delete; the destructive path can only be reached by
 * asking for it explicitly.
 */
export const deleteInputSchema = z.object({
  path: z.string().min(1),
  permanent: z.boolean().optional().default(false),
});

export type DeleteInput = z.infer<typeof deleteInputSchema>;

// ─── Bulk operations over a selection ───────────────────────────────────────

/**
 * Every operation the panel can apply to a MULTI-file selection takes the
 * whole selection in ONE request.
 *
 * The panel used to loop the single-path endpoint once per selected file.
 * Delete looped sequentially; move and copy were worse — `paths.map()` +
 * `Promise.all` put every request in flight at once. A move of ~120 files
 * measured 62 requests in two seconds on production (2026-09-02), which:
 *
 *   1. tripped the global API rate limit (100/window) with a 429 — and the
 *      429s hit everything else the panel was doing too (directory listings,
 *      /files/status), so the whole page looked dead;
 *   2. rejected the `Promise.all` on the FIRST 429 while the other requests
 *      kept running, leaving a partial move the user was never told about —
 *      the dialog stayed open and the error said only "Too many requests";
 *   3. re-patched the file-manager's last-access annotation once per path,
 *      turning one selection into dozens of concurrent kube-API writes on a
 *      single Deployment object.
 *
 * The cap is per REQUEST, not per selection: the panel splits a larger
 * selection into consecutive requests of this size and reports one continuous
 * progress bar across them. A 5000-file move is therefore 10 requests, not
 * 5000.
 *
 * 500 is set by the platform's OWN WAF, not by anything in this codebase.
 * ModSecurity's JSON body processor flattens every array element into a
 * separate ARGS entry, and `modsecurity.conf` rule **200007** rejects a
 * request whose argument count reaches 1000:
 *
 *   ModSecurity: Access denied with code 400 (phase 2). Matched "Operator
 *   `Ge' with parameter `1000' against variable `ARGS' (Value: `1000')
 *   [id "200007"] [msg "Failed to fully parse request body due to large
 *   argument count"]
 *
 * So `paths` + the sibling fields must stay under 1000 entries or the request
 * never reaches the API at all — it dies at the edge as a bare nginx 400 with
 * no error envelope. Measured on a live cluster (2026-09-02): 900 paths pass,
 * 1000 are refused. 500 leaves room for the extra fields on bulk-chown and for
 * a future CRS tightening, without weakening the WAF for everyone else.
 */
export const MAX_BULK_PATHS = 500;

/** @deprecated Use {@link MAX_BULK_PATHS} — kept so older imports still resolve. */
export const MAX_BULK_DELETE_PATHS = MAX_BULK_PATHS;

const bulkPathsSchema = z.array(z.string().min(1)).min(1).max(MAX_BULK_PATHS);

/**
 * Per-path outcome, shared by every bulk operation. Deliberately NOT
 * all-or-nothing: a bulk op that stops at the first failure is exactly what
 * produced the untraceable partial state. The caller is told which paths
 * succeeded and which did not, with a reason for each failure.
 */
export const bulkOperationResultSchema = z.object({
  succeeded: z.array(z.string()),
  failed: z.array(z.object({ path: z.string(), error: z.string() })),
});

export type BulkOperationResult = z.infer<typeof bulkOperationResultSchema>;

export const bulkDeleteInputSchema = z.object({
  paths: bulkPathsSchema,
  /** See deleteInputSchema — defaults to the recoverable branch. */
  permanent: z.boolean().optional().default(false),
});

export type BulkDeleteInput = z.infer<typeof bulkDeleteInputSchema>;

export const bulkDeleteResultSchema = bulkOperationResultSchema.extend({
  /** Recycle-bin ids for the paths that were trashed (empty when the caller
   *  asked for a permanent delete). Carried so the panel can offer a one-click
   *  Undo without making the user open the bin and match filenames by hand. */
  trashedIds: z.array(z.string()),
});

export type BulkDeleteResult = z.infer<typeof bulkDeleteResultSchema>;

/**
 * Move / copy many entries INTO a directory.
 *
 * `destDir` is a directory, not a per-path destination: the server joins it
 * with each source's basename. The panel used to compute `dest` itself with
 * `sourcePath.split('/').pop()` per file, duplicating that join at every call
 * site — and a bulk move is always "put these N things in that folder".
 * Single-entry RENAME (a new name in the same directory) stays on
 * `renameInputSchema`; the two are different operations.
 */
export const bulkMoveInputSchema = z.object({
  paths: bulkPathsSchema,
  destDir: z.string().min(1),
});

export type BulkMoveInput = z.infer<typeof bulkMoveInputSchema>;

export const bulkCopyInputSchema = bulkMoveInputSchema;
export type BulkCopyInput = z.infer<typeof bulkCopyInputSchema>;

export const bulkChmodInputSchema = z.object({
  paths: bulkPathsSchema,
  mode: z.string().regex(/^[0-7]{3,4}$/, 'mode must be an octal string (e.g. "755")'),
  recursive: z.boolean().optional(),
});

export type BulkChmodInput = z.infer<typeof bulkChmodInputSchema>;

export const bulkChownInputSchema = z.object({
  paths: bulkPathsSchema,
  uid: z.number().int().min(0).optional(),
  gid: z.number().int().min(0).optional(),
  owner: z.string().max(32).optional(),
  group: z.string().max(32).optional(),
  recursive: z.boolean().optional(),
}).refine(
  data => data.uid !== undefined || data.gid !== undefined || data.owner !== undefined || data.group !== undefined,
  { message: 'At least one of uid/owner or gid/group must be provided' },
);

export type BulkChownInput = z.infer<typeof bulkChownInputSchema>;

/**
 * NDJSON frames streamed by every bulk endpoint.
 *
 * Same shapes `/files/archive` and `/files/extract` already emit, so the
 * panel's existing `streamNdjsonOperation` reader consumes them unchanged.
 *
 * A per-path failure is NOT an `error` frame — it rides in `complete.failed`.
 * `error` means the operation as a whole could not run (file-manager
 * unreachable, tenant namespace gone); it is the only frame that makes the
 * client throw. Confusing the two is what made a partial result look total.
 */
export type BulkProgressFrame =
  | { readonly type: 'start'; readonly total: number }
  | { readonly type: 'progress'; readonly done: number; readonly total: number; readonly percent: number; readonly current: string }
  | ({ readonly type: 'complete' } & BulkOperationResult & { readonly trashedIds?: readonly string[] })
  | { readonly type: 'error'; readonly message: string };

// ─── Copy ───────────────────────────────────────────────────────────────────

export const copyInputSchema = z.object({
  sourcePath: z.string().min(1),
  destPath: z.string().min(1),
});

export type CopyInput = z.infer<typeof copyInputSchema>;

// ─── Archive ────────────────────────────────────────────────────────────────

export const archiveInputSchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
  destPath: z.string().min(1),
  format: z.enum(['zip', 'tar.gz', 'tar']).default('tar.gz'),
});

export type ArchiveInput = z.infer<typeof archiveInputSchema>;

// ─── Extract ────────────────────────────────────────────────────────────────

export const extractInputSchema = z.object({
  path: z.string().min(1),
  destPath: z.string().min(1).default('/'),
});

export type ExtractInput = z.infer<typeof extractInputSchema>;

// ─── Git Clone ──────────────────────────────────────────────────────────────

export const gitCloneInputSchema = z.object({
  url: z.string().url(),
  destPath: z.string().min(1),
});

export type GitCloneInput = z.infer<typeof gitCloneInputSchema>;

// ─── Chmod / Chown ──────────────────────────────────────────────────────────

export const chmodInputSchema = z.object({
  path: z.string().min(1),
  mode: z.string().regex(/^[0-7]{3,4}$/, 'mode must be an octal string (e.g. "755")'),
  recursive: z.boolean().optional(),
});

export type ChmodInput = z.infer<typeof chmodInputSchema>;

export const chownInputSchema = z.object({
  path: z.string().min(1),
  uid: z.number().int().min(0).optional(),
  gid: z.number().int().min(0).optional(),
  owner: z.string().max(32).optional(),
  group: z.string().max(32).optional(),
  recursive: z.boolean().optional(),
}).refine(data => data.uid !== undefined || data.gid !== undefined || data.owner !== undefined || data.group !== undefined, {
  message: 'At least one of uid/owner or gid/group must be provided',
});

export type ChownInput = z.infer<typeof chownInputSchema>;

// ─── Disk Usage ─────────────────────────────────────────────────────────────

/**
 * `trashBytes` is a SUBSET of `usedBytes`, not an addition — the recycle bin
 * lives on the same PVC, so trashing a file frees nothing until it is purged.
 * The UI must break this out: with no size cap on the bin, showing the tenant
 * what it costs is the only thing standing between them and a full PVC.
 */
export const diskUsageSchema = z.object({
  usedBytes: z.number(),
  totalBytes: z.number(),
  availableBytes: z.number(),
  trashBytes: z.number(),
  usedFormatted: z.string(),
  totalFormatted: z.string(),
  availableFormatted: z.string(),
  trashFormatted: z.string(),
  /** Added by the backend, not the sidecar — the sidecar never owns policy.
   *  Carried here so the delete dialog can say "kept N days" without listing
   *  the whole bin for one number. */
  trashRetentionDays: z.number().int().positive(),
});

export type DiskUsage = z.infer<typeof diskUsageSchema>;

// ─── File Manager Status ─────────────────────────────────────────────────────

export const fileManagerStatusSchema = z.object({
  ready: z.boolean(),
  phase: z.enum(['not_deployed', 'starting', 'ready', 'failed', 'stopping']),
  message: z.string().optional(),
});

export type FileManagerStatus = z.infer<typeof fileManagerStatusSchema>;

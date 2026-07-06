import { z } from 'zod';
import { uuidField, paginatedResponseSchema } from './shared.js';

// ─── Enums (mirror DB enums from migration 0076) ─────────────────────────────

export const restoreJobStatusSchema = z.enum(['draft', 'executing', 'paused', 'done', 'failed']);
export type RestoreJobStatus = z.infer<typeof restoreJobStatusSchema>;

export const restoreItemTypeSchema = z.enum([
  'files-paths',
  'mailboxes-by-address',
  'deployments-by-id',
  'databases-by-id',
  'domains-by-id',
  'config-tables',
]);
export type RestoreItemType = z.infer<typeof restoreItemTypeSchema>;

export const restoreItemStatusSchema = z.enum([
  'pending',
  'applying',
  'done',
  'failed',
  'skipped',
]);
export type RestoreItemStatus = z.infer<typeof restoreItemStatusSchema>;

// ─── Type-specific selectors ─────────────────────────────────────────────────

/** files-paths: either restore the full archive or specific paths. */
export const filesPathsSelectorSchema = z.union([
  z.object({ kind: z.literal('full') }),
  z.object({
    kind: z.literal('paths'),
    // Per-path length cap — each path is interpolated into the restore
    // Job's `restic --include '<path>'` args, which land in the Job
    // `command` field in etcd (≤~1.5 MiB/object). 4 KiB × 10k keeps the
    // rendered script well under that ceiling.
    paths: z.array(z.string().min(1).max(4096)).min(1).max(10000),
  }),
]);
export type FilesPathsSelector = z.infer<typeof filesPathsSelectorSchema>;

/**
 * Mailbox restore mode.
 *
 * - merge-skip-duplicates  (default): APPEND only messages whose Message-ID
 *                                     is not already present. Idempotent.
 * - merge-overwrite                 : APPEND every message; server keeps
 *                                     duplicates.
 * - replace                         : Wipe existing folder contents (via
 *                                     atomic IMAP RENAME-to-staging then
 *                                     APPEND), then DELETE staging on
 *                                     success. Mid-run crash leaves staging
 *                                     for operator inspection.
 *
 * `replace` is destructive — tenants MUST set `confirmDestructive: true`
 * to opt in (matches the `confirm_destructive_shrink` typed-confirmation
 * pattern used elsewhere in the platform).
 */
export const mailboxRestoreModeSchema = z.enum([
  'merge-skip-duplicates',
  'merge-overwrite',
  'replace',
]);
export type MailboxRestoreMode = z.infer<typeof mailboxRestoreModeSchema>;

export const MAILBOX_RESTORE_MODE_DEFAULT: MailboxRestoreMode = 'merge-skip-duplicates';

export const mailboxesSelectorSchema = z.union([
  z.object({
    kind: z.literal('all'),
    mode: mailboxRestoreModeSchema.optional(),
    confirmDestructive: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('addresses'),
    addresses: z.array(z.string().email()).min(1).max(1000),
    mode: mailboxRestoreModeSchema.optional(),
    confirmDestructive: z.boolean().optional(),
  }),
]).superRefine((sel, ctx) => {
  if (sel.mode === 'replace' && sel.confirmDestructive !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'mailbox restore mode "replace" requires confirmDestructive: true',
      path: ['confirmDestructive'],
    });
  }
});
export type MailboxesSelector = z.infer<typeof mailboxesSelectorSchema>;

export const deploymentsSelectorSchema = z.union([
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('ids'), deploymentIds: z.array(uuidField).min(1).max(1000) }),
]);
export type DeploymentsSelector = z.infer<typeof deploymentsSelectorSchema>;

/**
 * databases-by-id: restore a tenant's add-on database(s) from the
 * per-database `.sql` dump captured inside the files snapshot
 * (`databases/<deploymentName>/predump-<db>-<bundleId>.sql`, ADR-047).
 *
 *   { kind: 'all' }                     → every database deployment of
 *                                         the tenant.
 *   { kind: 'ids', deploymentIds: […] } → the given deployments, each
 *                                         validated to belong to the
 *                                         tenant AND be a `type='database'`
 *                                         catalog deployment.
 *
 * The dumps ride on the `files` component — a `databases-by-id` item is
 * only meaningful AFTER a `files-paths` restore has landed the `.sql`
 * on the tenant PVC.
 */
export const databasesSelectorSchema = z.union([
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('ids'), deploymentIds: z.array(uuidField).min(1).max(100) }),
]);
export type DatabasesSelector = z.infer<typeof databasesSelectorSchema>;

export const domainsSelectorSchema = z.union([
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('ids'), domainIds: z.array(uuidField).min(1).max(1000) }),
]);
export type DomainsSelector = z.infer<typeof domainsSelectorSchema>;

export const configTablesSelectorSchema = z.union([
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('tables'), tables: z.array(z.string().min(1)).min(1).max(50) }),
]);
export type ConfigTablesSelector = z.infer<typeof configTablesSelectorSchema>;

/** Discriminated union of all selectors, paired with type. */
export const restoreItemPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('files-paths'), selector: filesPathsSelectorSchema }),
  z.object({ type: z.literal('mailboxes-by-address'), selector: mailboxesSelectorSchema }),
  z.object({ type: z.literal('deployments-by-id'), selector: deploymentsSelectorSchema }),
  z.object({ type: z.literal('databases-by-id'), selector: databasesSelectorSchema }),
  z.object({ type: z.literal('domains-by-id'), selector: domainsSelectorSchema }),
  z.object({ type: z.literal('config-tables'), selector: configTablesSelectorSchema }),
]);
export type RestoreItemPayload = z.infer<typeof restoreItemPayloadSchema>;

// ─── API DTOs ────────────────────────────────────────────────────────────────

export const createRestoreCartSchema = z.object({
  tenantId: uuidField,
  description: z.string().max(2000).nullable().optional(),
});
export type CreateRestoreCartInput = z.infer<typeof createRestoreCartSchema>;

export const addRestoreItemSchema = restoreItemPayloadSchema.and(
  z.object({
    bundleId: z.string().min(1),
    label: z.string().max(255).nullable().optional(),
  }),
);
export type AddRestoreItemInput = z.infer<typeof addRestoreItemSchema>;

export const restoreJobSummarySchema = z.object({
  id: z.string(),
  tenantId: uuidField,
  initiatorUserId: uuidField.nullable(),
  status: restoreJobStatusSchema,
  preRestoreSnapshotId: z.string().nullable(),
  description: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RestoreJobSummary = z.infer<typeof restoreJobSummarySchema>;

export const restoreItemInfoSchema = z.object({
  id: uuidField,
  restoreJobId: z.string(),
  bundleId: z.string(),
  type: restoreItemTypeSchema,
  selector: z.record(z.string(), z.unknown()),
  label: z.string().nullable(),
  seq: z.number().int().nonnegative(),
  status: restoreItemStatusSchema,
  progressMessage: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type RestoreItemInfo = z.infer<typeof restoreItemInfoSchema>;

export const restoreJobDetailSchema = restoreJobSummarySchema.extend({
  items: z.array(restoreItemInfoSchema),
});
export type RestoreJobDetail = z.infer<typeof restoreJobDetailSchema>;

export const restoreJobListResponseSchema = paginatedResponseSchema(restoreJobSummarySchema);
export type RestoreJobListResponse = z.infer<typeof restoreJobListResponseSchema>;

// ─── Bundle-browse responses ────────────────────────────────────────────────
//
// Used by the cart UI to populate the "what can I restore from this
// bundle?" picker. Each call sources data from a single bundle on the
// off-site target via BackupStore.readComponent + parsing.

// Restic-native lazy tree browse. Each call lists the DIRECT CHILDREN
// of `path` (a relative DISPLAY path, no leading slash / no `/source`
// prefix — that prefix is restic's internal capture root, stripped
// server-side). The UI lazily fetches one directory level per call via
// GET .../files/tree?path=<dir>. Entries are sorted dirs-first then by
// name.
export const bundleBrowseFileEntrySchema = z.object({
  /** Base name of the entry (last path segment). */
  name: z.string(),
  /** Full DISPLAY path relative to the snapshot root, no leading slash. */
  path: z.string(),
  type: z.enum(['file', 'dir']),
  size: z.number().int().nonnegative(),
});
export type BundleBrowseFileEntry = z.infer<typeof bundleBrowseFileEntrySchema>;

export const bundleBrowseFilesTreeResponseSchema = z.object({
  bundleId: z.string(),
  /** The directory whose direct children `entries` lists ('' = root). */
  path: z.string(),
  entries: z.array(bundleBrowseFileEntrySchema),
});
export type BundleBrowseFilesTreeResponse = z.infer<typeof bundleBrowseFilesTreeResponseSchema>;

export const bundleBrowseMailboxesResponseSchema = z.object({
  bundleId: z.string(),
  addresses: z.array(z.string()),
});
export type BundleBrowseMailboxesResponse = z.infer<typeof bundleBrowseMailboxesResponseSchema>;

export const bundleBrowseDeploymentsResponseSchema = z.object({
  bundleId: z.string(),
  deployments: z.array(z.object({
    id: uuidField,
    name: z.string(),
  })),
});
export type BundleBrowseDeploymentsResponse = z.infer<typeof bundleBrowseDeploymentsResponseSchema>;

export const bundleBrowseDomainsResponseSchema = z.object({
  bundleId: z.string(),
  domains: z.array(z.object({
    id: uuidField,
    hostname: z.string(),
  })),
});
export type BundleBrowseDomainsResponse = z.infer<typeof bundleBrowseDomainsResponseSchema>;

export const bundleBrowseConfigTablesResponseSchema = z.object({
  bundleId: z.string(),
  tables: z.array(z.object({
    name: z.string(),
    rowCount: z.number().int().nonnegative(),
  })),
});
export type BundleBrowseConfigTablesResponse = z.infer<typeof bundleBrowseConfigTablesResponseSchema>;

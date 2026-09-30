/**
 * Bundle re-import from a direct upload (ADR-063).
 *
 * The transport is the EXISTING chunked file upload — the archive is uploaded
 * to `.insula-imports/<importId>.<ext>` on the tenant's own file space through
 * `/tenants/:id/files/upload-raw`, which already carries the WAF carve-out.
 * These contracts cover only the two calls that bracket it: the preflight that
 * reads the archive's `meta.json`, and the start call that launches the import.
 */
import { z } from 'zod';

/** Directory on the tenant file space that uploads land in. */
export const BUNDLE_IMPORT_UPLOAD_DIR = '.insula-imports';

/** Archive extensions the import accepts. ZIP is excluded on purpose — its
 *  index lives at the END of the file, so its meta cannot be read by streaming. */
export const BUNDLE_IMPORT_EXTENSIONS = ['tar.gz', 'tar.gz.enc'] as const;

/**
 * Client-generated id for one import attempt.
 *
 * Deliberately narrow: it becomes a filename on the tenant PVC, a Job name, a
 * Secret name and a restic tag, so anything outside this shape is refused
 * before it can reach any of them.
 */
export const bundleImportIdSchema = z.string().regex(
  /^[A-Za-z0-9_-]{1,64}$/,
  'import id must be 1-64 characters of letters, digits, hyphen or underscore',
);

export const bundleImportComponentSchema = z.enum(['files', 'mailboxes', 'config', 'secrets']);
export const bundleImportUnitComponentSchema = z.enum(['files', 'mailboxes']);

export const bundleImportPreflightInputSchema = z.object({
  importId: bundleImportIdSchema,
  /** Extension of the uploaded file; selects the decode pipeline. */
  extension: z.enum(BUNDLE_IMPORT_EXTENSIONS).optional().default('tar.gz'),
  /** Required for a `Salted__`-encrypted archive. */
  passphrase: z.string().min(1).max(512).optional(),
});
export type BundleImportPreflightInput = z.infer<typeof bundleImportPreflightInputSchema>;

export const bundleImportUnitSchema = z.object({
  component: bundleImportUnitComponentSchema,
  name: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});
export type BundleImportUnit = z.infer<typeof bundleImportUnitSchema>;

export const bundleImportObjectArtifactSchema = z.object({
  component: z.enum(['config', 'secrets']),
  name: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});

export const bundleImportDroppedSchema = z.object({
  component: z.string(),
  /** Why it will not be imported. Surfaced verbatim — never dropped silently. */
  reason: z.string(),
});

export const bundleImportRejectedAddressSchema = z.object({
  address: z.string(),
  domain: z.string(),
  reason: z.string(),
});

export const bundleImportPreflightSchema = z.object({
  importId: bundleImportIdSchema,
  format: z.enum(['tar-plain', 'tar-encrypted', 'zip']),
  sourceBundleId: z.string().nullable(),
  sourceTenantId: z.string().nullable(),
  units: z.array(bundleImportUnitSchema),
  objectArtifacts: z.array(bundleImportObjectArtifactSchema),
  dropped: z.array(bundleImportDroppedSchema),
  totalBytes: z.number().int().nonnegative(),
  /** Kubernetes quantity for the import Job's staging volume, e.g. `"11Gi"`. */
  stageSizeLimit: z.string(),
  quota: z.object({
    limitBytes: z.number().int().nonnegative(),
    incomingBytes: z.number().int().nonnegative(),
    fits: z.boolean(),
  }),
  mailboxDomains: z.object({
    ok: z.boolean(),
    rejected: z.array(bundleImportRejectedAddressSchema),
  }),
  warnings: z.array(z.string()),
  /** True when the import must not proceed. Distinct from a warning. */
  blocked: z.boolean(),
  blockReasons: z.array(z.string()),
});
export type BundleImportPreflight = z.infer<typeof bundleImportPreflightSchema>;

export const bundleImportStartInputSchema = z.object({
  importId: bundleImportIdSchema,
  extension: z.enum(BUNDLE_IMPORT_EXTENSIONS).optional().default('tar.gz'),
  passphrase: z.string().min(1).max(512).optional(),
  /** Backup target the resulting bundle is written to. */
  targetConfigId: z.string().min(1).max(36),
  /** Operator note appended to the `manual-import` label. */
  label: z.string().max(200).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
});
export type BundleImportStartInput = z.infer<typeof bundleImportStartInputSchema>;

export const bundleImportResultSchema = z.object({
  bundleId: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  unitCount: z.number().int().nonnegative(),
  objectCount: z.number().int().nonnegative(),
  label: z.string(),
});
export type BundleImportResult = z.infer<typeof bundleImportResultSchema>;

/** Every bundle created by upload carries this label. */
export const MANUAL_IMPORT_LABEL = 'manual-import';

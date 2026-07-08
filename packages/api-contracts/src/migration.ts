/**
 * Cross-cluster tenant migration (R20).
 *
 * Cluster B mounts cluster A's tenant backup target READ-ONLY (a backup
 * target config on B pointing at A's store), scans it for tenants, and
 * imports single/all — no preparation on A. Each import re-creates the
 * tenant from its newest bundle's meta.json (preserving the original id +
 * namespace) and restores components straight from A's target. Works on a
 * fresh cluster (target sourced from a secrets bundle) or an existing one
 * (operator configures A's target manually for migration).
 */

import { z } from 'zod';

/** A tenant discovered on a mounted (read-only) SOURCE backup target. */
export const migrationTenantSchema = z.object({
  tenantId: z.string(),
  tenantName: z.string(),
  primaryEmail: z.string().nullable(),
  /** Newest COMPLETED bundle for this tenant on the source target. */
  latestBundleId: z.string(),
  latestCreatedAt: z.string(),
  /** How many bundles for this tenant were found on the source. */
  bundleCount: z.number().int().nonnegative(),
  /** Sum of component sizes in the latest bundle (bytes; 0 if unknown). */
  totalSizeBytes: z.number().int().nonnegative(),
  /** Components present in the latest bundle (files/config/mailboxes/secrets). */
  components: z.array(z.string()),
  platformVersion: z.string().nullable(),
  /** A tenant with this id ALREADY exists on THIS (destination) cluster. */
  alreadyPresent: z.boolean(),
});
export type MigrationTenant = z.infer<typeof migrationTenantSchema>;

export const migrationListRequestSchema = z.object({
  /** Backup target config id (on THIS cluster) that points at the source. */
  targetConfigId: z.string().min(1),
});
export type MigrationListRequest = z.infer<typeof migrationListRequestSchema>;

export const migrationListResponseSchema = z.object({
  targetConfigId: z.string(),
  tenants: z.array(migrationTenantSchema),
  /** Total bundle prefixes scanned on the source. */
  scanned: z.number().int().nonnegative(),
  /** Bundles skipped (missing/invalid meta.json — in-flight or foreign). */
  skipped: z.number().int().nonnegative(),
});
export type MigrationListResponse = z.infer<typeof migrationListResponseSchema>;

export const migrationImportRequestSchema = z.object({
  targetConfigId: z.string().min(1),
  /** Explicit tenant ids to import. Ignored when scope='all'. */
  tenantIds: z.array(z.string().min(1)).optional(),
  /** 'selected' → import tenantIds; 'all' → import every discovered tenant. */
  scope: z.enum(['selected', 'all']).default('selected'),
  /** Resolve the target set + presence without importing. */
  dryRun: z.boolean().default(false),
});
export type MigrationImportRequest = z.infer<typeof migrationImportRequestSchema>;

export const migrationImportResultSchema = z.object({
  tenantId: z.string(),
  tenantName: z.string().nullable(),
  bundleId: z.string(),
  ok: z.boolean(),
  /** Restore-cart terminal status, or 'skipped' / 'dry-run' / 'failed'. */
  status: z.string().nullable(),
  recreated: z.boolean(),
  alreadyPresent: z.boolean(),
  cartId: z.string().nullable(),
  residualGaps: z.array(z.string()),
  error: z.string().nullable(),
});
export type MigrationImportResult = z.infer<typeof migrationImportResultSchema>;

export const migrationImportResponseSchema = z.object({
  targetConfigId: z.string(),
  total: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  dryRun: z.boolean(),
  results: z.array(migrationImportResultSchema),
});
export type MigrationImportResponse = z.infer<typeof migrationImportResponseSchema>;

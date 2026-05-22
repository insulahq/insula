import { z } from 'zod';

// ─── CNPG backup catalogue (Phase 2 — 2026-05-22) ────────────────────────────
//
// Object-store source-of-truth listing of barman-cloud backups for a CNPG
// cluster. Distinct from /admin/cnpg-backup-health which reads CNPG Backup
// CRs from the cluster API — the catalogue is reachable EVEN WHEN THE CNPG
// OPERATOR IS DOWN, because the shim owns the upstream object-store
// connection independently of the cluster control plane.

export const catalogueSourceSchema = z.enum(['object-store', 'unavailable']);
export type CatalogueSource = z.infer<typeof catalogueSourceSchema>;

export const cnpgCatalogueBackupSchema = z.object({
  backupId: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  status: z.string().nullable(),
  beginWal: z.string().nullable(),
  endWal: z.string().nullable(),
  clusterSizeBytes: z.number().int().nonnegative().nullable(),
  dataSizeBytes: z.number().int().nonnegative().nullable(),
  uploadedAt: z.string().nullable(),
  parseError: z.string().nullable(),
});
export type CnpgCatalogueBackup = z.infer<typeof cnpgCatalogueBackupSchema>;

export const cnpgBackupCatalogueResponseSchema = z.object({
  source: catalogueSourceSchema,
  objectStoreName: z.string(),
  namespace: z.string(),
  backups: z.array(cnpgCatalogueBackupSchema),
  /** Set when source='unavailable'; surface to the operator as the reason. */
  unavailableReason: z.string().nullable(),
  queryDurationMs: z.number().int().nonnegative(),
});
export type CnpgBackupCatalogueResponse = z.infer<typeof cnpgBackupCatalogueResponseSchema>;

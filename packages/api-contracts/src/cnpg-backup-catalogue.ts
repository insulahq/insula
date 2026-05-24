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
  /**
   * 2026-05-24 (Phase 7b): operator-supplied description, read from
   * the matching CNPG Backup CR's `platform.phoenix-host.net/description`
   * label. Null when the label is absent (scheduled backups,
   * pre-Phase-7b on-demand backups). The frontend renders this verbatim
   * when present; otherwise it falls back to a name-pattern label
   * ("Scheduled Backup" / "On-demand" / "Pre-restore").
   */
  description: z.string().nullable().optional(),
  /**
   * 2026-05-24 (Phase 7b): derived from the CR's labels. Helps the
   * frontend render the right fallback when `description` is null.
   * Returned only when the CR was found in the cluster API; null when
   * the catalogue entry exists in barman but the CR was already
   * pruned by CNPG's Backup CR TTL.
   */
  kind: z.enum(['scheduled', 'on-demand', 'pre-restore', 'unknown']).nullable().optional(),
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

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
   * the matching CNPG Backup CR's `insula.host/description`
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

/**
 * The WAL half of the archive: how many segments are retained offsite, what
 * they cost, and how far back they reach. Base backups alone cannot answer
 * "how far back can I recover to" — the WAL between them is what makes an
 * arbitrary point in time restorable.
 */
export const walArchiveSummarySchema = z.object({
  segmentCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  oldestAt: z.string().nullable(),
  newestAt: z.string().nullable(),
  /** The page cap or the deadline cut the walk short — counts are a floor. */
  truncated: z.boolean(),
  /**
   * Set when nothing could be measured. The panel SAYS so rather than
   * spinning: an unresolved cell is indistinguishable from a broken target.
   */
  readError: z.string().nullable(),
  queryDurationMs: z.number().int().nonnegative(),
});
export type WalArchiveSummary = z.infer<typeof walArchiveSummarySchema>;

export const cnpgBackupCatalogueResponseSchema = z.object({
  source: catalogueSourceSchema,
  objectStoreName: z.string(),
  namespace: z.string(),
  backups: z.array(cnpgCatalogueBackupSchema),
  /** Set when source='unavailable'; surface to the operator as the reason. */
  unavailableReason: z.string().nullable(),
  queryDurationMs: z.number().int().nonnegative(),
  /**
   * Always null here — the WAL side has its own endpoint because it is orders
   * of magnitude cheaper than enumerating base backups. Kept so older clients
   * that read the field still parse.
   */
  walSummary: walArchiveSummarySchema.nullable(),
  /**
   * The enumeration hit its deadline: `backups` is what had been read by then.
   * Measured on DEV 2026-09-11 — 29 backups took over three minutes through the
   * shim, so an unbounded call means a panel that never resolves.
   */
  partial: z.boolean(),
});
export type CnpgBackupCatalogueResponse = z.infer<typeof cnpgBackupCatalogueResponseSchema>;

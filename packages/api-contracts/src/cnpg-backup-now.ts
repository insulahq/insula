import { z } from 'zod';

// ─── On-demand CNPG Backup CR creation (Phase 1 — 2026-05-24) ────────────────
//
// Operator-triggered "Backup Now" — creates a single Backup CR
// (apiVersion: postgresql.cnpg.io/v1) against the named cluster. The CNPG
// operator's barman-cloud plugin sidecar handles the actual pg_basebackup
// and uploads to the configured ObjectStore.
//
// Returns immediately after the CR is accepted by Kubernetes; the actual
// upload runs in the cluster control plane. The operator polls completion
// via the existing /admin/cnpg-backup-catalogue (catalogue refresh) or
// /admin/cnpg-backup-health (rolled-up state) endpoints.

// Lowercase-only DNS label, capped at 50 chars to match the service-layer
// guard (cnpg-backup-now/service.ts:NAME_RE). Mirrors postgres-barman-restore.
// The 50 (not 63) cap matches the upstream guard exactly so a name accepted
// by the schema is always accepted by the service — drop the `i` flag and
// tighten the length to keep the contract honest.
const dnsLabel = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'must be a DNS-label (lower-case, ≤50 chars)');

export const cnpgBackupNowRequestSchema = z.object({
  namespace: dnsLabel,
  clusterName: dnsLabel,
  /**
   * Optional operator-supplied description, attached to the Backup CR
   * as the `insula.host/description` ANNOTATION (not
   * label — annotations have no charset/length restrictions, so the
   * operator can type spaces and natural-language descriptions like
   * "before tenant import: acme"). Surfaced in the catalogue list.
   * Capped at 200 chars for sensible UI rendering.
   */
  description: z
    .string()
    .max(200)
    .optional(),
});
export type CnpgBackupNowRequest = z.infer<typeof cnpgBackupNowRequestSchema>;

export const cnpgBackupNowResponseSchema = z.object({
  backupName: z.string(),
  namespace: z.string(),
  clusterName: z.string(),
  /** When the CR was created. Useful for the UI to surface ETA. */
  createdAt: z.string(),
});
export type CnpgBackupNowResponse = z.infer<typeof cnpgBackupNowResponseSchema>;

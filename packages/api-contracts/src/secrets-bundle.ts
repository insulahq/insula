/**
 * Bundle on-disk format v2 (DR-bundle bundle-everything redesign).
 *
 * Every bundle contains:
 *   - `MANIFEST.txt`  — plain-text header for human inspection (`tar tf …`)
 *   - `MANIFEST.json` — machine-readable record consumed by the restore
 *                       profile gating in `bootstrap.sh` /
 *                       `make secrets-restore`.
 *   - `<namespace>__<name>.yaml` per Secret — apply-ready Secret YAML.
 *
 * The `restoreTier` field on each entry tells `bootstrap.sh
 * --restore-profile=…` whether to apply at all:
 *   - `conservative` profile applies `tier-1-platform` only.
 *   - `full` profile applies tier-1 + tier-2 + unclassified.
 *   - Any entry in `skipAtRestore` is refused by both profiles
 *     unless `--override-skip-at-restore` is also passed.
 *
 * `--dry-run` / `--extract-to=<path>` are orthogonal flags handled
 * by the apply helper.
 */

import { z } from 'zod';

export const bundleEntryTierSchema = z.enum([
  'tier-1-platform',
  'tier-2-tenant',
  'unclassified',
]);
export type BundleEntryTier = z.infer<typeof bundleEntryTierSchema>;

export const bundleEntrySchema = z.object({
  namespace: z.string().min(1).max(253),
  name: z.string().min(1).max(253),
  /** k8s Secret `type` field. */
  type: z.string().max(253),
  restoreTier: bundleEntryTierSchema,
  /** sha256 of the entry's serialised YAML; restore tooling should
   *  verify before `kubectl apply` to catch bundle corruption. */
  sha256OfYaml: z.string().length(64),
});
export type BundleEntry = z.infer<typeof bundleEntrySchema>;

export const bundleSkipAtRestoreSchema = z.object({
  namespace: z.string().min(1).max(253),
  name: z.string().min(1).max(253),
  reason: z.string().min(1).max(500),
});
export type BundleSkipAtRestore = z.infer<typeof bundleSkipAtRestoreSchema>;

/** Machine-readable manifest embedded as `MANIFEST.json` inside the tar. */
export const bundleManifestSchema = z.object({
  bundleFormat: z.literal(2),
  generatedAt: z.string().datetime(),
  /** Who built this bundle. Useful for forensics. */
  generator: z.enum(['in-cluster', 'bootstrap.sh', 'cronjob']),
  /** Age public key the tar was encrypted to. Surfaces visible
   *  before decryption so the operator can confirm provenance. */
  operatorRecipient: z.string(),
  /** Cluster-side hostname when generator='bootstrap.sh' or 'cronjob'. */
  clusterHostname: z.string().nullable(),
  entries: z.array(bundleEntrySchema),
  /** Snapshot of the secrets-audit-allowlist at export time. Travels
   *  with the bundle so restore can apply the operator's intent even
   *  on a cluster that doesn't have the original ConfigMap. */
  skipAtRestore: z.array(bundleSkipAtRestoreSchema),
});
export type BundleManifest = z.infer<typeof bundleManifestSchema>;

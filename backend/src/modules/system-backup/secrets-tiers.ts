/**
 * Restore-tier assignment by namespace (bundle-everything redesign).
 *
 * The bundle exporter tags every (non-denied) Secret with one of:
 *   - tier-1-platform  → applied by the `conservative` restore profile.
 *     These are the Secrets a fresh-cluster bootstrap needs before
 *     platform-api can come up. Workload-restore can wait.
 *   - tier-2-tenant    → applied by the `full` restore profile.
 *     Per-tenant credentials; out of scope for first-cluster-boot.
 *   - unclassified     → applied by the `full` restore profile.
 *     Operator-installed third-party components (monitoring,
 *     ingress controllers in non-standard namespaces, etc.).
 *
 * Tier assignment is namespace-based (cheap, no IO required). The
 * shell exporter has a mirror of this map in jq (`scripts/lib/
 * secrets-denylist.jq`); CI parity test catches drift.
 */

export type RestoreTier = 'tier-1-platform' | 'tier-2-tenant' | 'unclassified';

/** Namespaces whose Secrets are needed by the conservative restore
 *  profile. Add to this set when a new platform-owned namespace
 *  needs to be bootstrapped before tenants come back up. */
export const TIER_1_PLATFORM_NAMESPACES: ReadonlySet<string> = new Set([
  'platform',
  'platform-system',
  'mail',
  'longhorn-system',
  'cnpg-system',
  'cert-manager',
  'dex',
  'oauth2-proxy',
  'traefik',
  'crowdsec',
]);

/** Tenant namespace prefix. Mirrors the existing `client-*`
 *  convention used by the nightly secrets-backup CronJob. */
const TENANT_NAMESPACE_RE = /^client-.+$/;

/** Pure function. Exported for unit testing. */
export function restoreTierForNamespace(namespace: string): RestoreTier {
  if (TIER_1_PLATFORM_NAMESPACES.has(namespace)) return 'tier-1-platform';
  if (TENANT_NAMESPACE_RE.test(namespace)) return 'tier-2-tenant';
  return 'unclassified';
}

/**
 * Critical Secrets that MUST be in any non-empty bundle export.
 *
 * The DR restore path is unrecoverable without these:
 *   - `platform/platform-secrets` holds PLATFORM_ENCRYPTION_KEY, which
 *     is the AES key for the encrypted credential columns in
 *     `backup_configurations` (sshKeyEncrypted / s3SecretKeyEncrypted /
 *     cifsPasswordEncrypted). Without it, dr-rows.json round-trips but
 *     every credential blob inside is unusable garbage.
 *   - `platform/backup-target-key` is the platform-wide CSPRNG that the
 *     backup-rclone-shim's HKDF derives per-class crypt keys from.
 *     Without it, every existing backup on the upstream repo (restic,
 *     barman, tenant bundles) is opaque encrypted bytes.
 *
 * Both live in `platform` namespace and are tier-1 by the namespace
 * sweep above. This explicit list is a regression guard — if someone
 * ever reshuffles the namespace map (moves a Secret to another ns, or
 * narrows the tier-1 set) we fail loudly at bundle-export time instead
 * of silently producing an unrestorable bundle.
 *
 * Format: `<namespace>/<name>`.
 */
export const CRITICAL_TIER_1_SECRETS: ReadonlyArray<string> = [
  'platform/platform-secrets',
  'platform/backup-target-key',
];

/** Returns the subset of CRITICAL_TIER_1_SECRETS that were NOT included
 *  in the manifest. Empty array means the bundle is decrypt-ready. */
export function findMissingCriticalSecrets(
  manifest: ReadonlyArray<{ namespace: string; name: string }>,
): string[] {
  const present = new Set(manifest.map((m) => `${m.namespace}/${m.name}`));
  return CRITICAL_TIER_1_SECRETS.filter((key) => !present.has(key));
}

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

import { isTenantNamespace } from '../../lib/namespace-tier.js';

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

/**
 * Pure function. Exported for unit testing.
 *
 * This used to test `/^client-.+$/`, a convention the platform no longer mints
 * — `tenants/service.ts:generateNamespace()` has produced `tenant-<slug>-<hex>`
 * for a long time, and production has ZERO `client-*` namespaces and zero
 * tenant rows outside `tenant-*` (checked 2026-08-31). So every real tenant
 * Secret was being labelled `unclassified` instead of `tier-2-tenant`.
 *
 * Behaviourally this was harmless — both tiers are bundled and both are applied
 * by the `full` restore profile, so nothing was ever missing from a bundle or
 * skipped on restore. It made the audit UI and the bundle summary wrong, which
 * is how an operator would read "0 tenant secrets" off a bundle that in fact
 * contained all of them.
 *
 * Now classified by the shared helper so it cannot drift from the rest of the
 * platform again. See lib/namespace-tier.ts.
 */
export function restoreTierForNamespace(namespace: string): RestoreTier {
  if (TIER_1_PLATFORM_NAMESPACES.has(namespace)) return 'tier-1-platform';
  if (isTenantNamespace(namespace)) return 'tier-2-tenant';
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

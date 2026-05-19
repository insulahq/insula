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

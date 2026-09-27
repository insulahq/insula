/**
 * Tier and ceiling derivation (ADR-062).
 *
 * Pure. Everything here is a decision about numbers, and the numbers came from
 * measurement rather than taste — keeping it free of I/O is what lets the
 * thresholds be argued with in a test instead of on a cluster.
 */

import {
  CPU_TIER_MILLICORES,
  type CpuTier,
  type CpuMigrationBlocker,
} from '@insula/api-contracts';

/**
 * Tier for a catalog entry that declares no tier of its own.
 *
 * The catalog is a separate public repo synced by every platform version, so
 * requiring a new field would be a flag day across three repositories and
 * would break every third-party catalog. Instead the tier is DERIVED from the
 * legacy `recommended.cpu`, which every manifest already carries:
 *
 *   <= 0.10 cores  -> normal    (static sites, caches)
 *   <= 0.50 cores  -> high      (runtimes, single-service apps, databases)
 *    > 0.50 cores  -> highest   (Nextcloud, Jitsi, Moodle-Bitnami, …)
 *
 * An author who disagrees sets `resources.cpu.tier` explicitly and this is
 * never consulted.
 */
export function deriveTier(recommendedCores: number | null): CpuTier {
  if (recommendedCores === null || Number.isNaN(recommendedCores)) return 'high';
  if (recommendedCores <= 0.10) return 'normal';
  if (recommendedCores <= 0.50) return 'high';
  return 'highest';
}

export function tierMillis(tier: CpuTier): number {
  return CPU_TIER_MILLICORES[tier];
}

/**
 * Tenant-wide burst ceiling, in cores, from the plan's legacy `cpu_limit`.
 *
 * Deliberately generous — `max(1, limit x 2)` — so that no tenant's USABLE
 * burst visibly shrinks at migration. Today there is no CPU limit at all, so
 * a tenant can burst to the whole node; reinterpreting `cpu_limit` as the
 * ceiling one-for-one would quietly convert "reserve 1 core, burst without
 * limit" into "burst to 1 core". The floor of 1 matters most for the smallest
 * plan: a 0.10 starter gets a 1-core ceiling, which is ten times its old
 * reservation and still a real bound.
 */
export function ceilingCores(planCpuLimitCores: number | null): number {
  const limit = planCpuLimitCores ?? 0;
  return Math.max(1, Math.round(limit * 2 * 100) / 100);
}

export interface DeploymentFacts {
  readonly source: 'catalog' | 'custom';
  /** True when the catalog entry came from a non-Official repository. */
  readonly thirdPartyCatalog: boolean;
  /** True when a custom deployment pins its own resources (ADR-036). */
  readonly declaresOwnResources: boolean;
}

/**
 * Why this deployment cannot be re-tiered unattended, or null.
 *
 * Only reasons that are a property of the DEPLOYMENT live here. "Does the
 * workload fit under the ceiling" is deliberately not one of them: the
 * ceiling is `ResourceQuota.limits.cpu`, which is tenant-wide, so asking it
 * per deployment answers a bound that does not exist. See tenantUsageBlocker.
 */
export function blockerFor(f: DeploymentFacts): CpuMigrationBlocker | null {
  // A bring-your-own image that pins its own resources is the operator's
  // declaration, not the platform's to overwrite.
  if (f.source === 'custom' && f.declaresOwnResources) return 'custom_resources';
  // A manifest we did not write, whose sizing we cannot vouch for.
  if (f.thirdPartyCatalog) return 'third_party_catalog';
  return null;
}

/**
 * Whether the tenant's measured load already exceeds the ceiling its plan
 * would grant.
 *
 * ★ Tenant-wide, and p95 rather than average.
 *
 * Tenant-wide because that is the shape of the bound being checked. An
 * earlier draft asked this per deployment against a per-deployment p95 — and
 * `usage_metrics.deployment_id` is NULL on every one of the 10,582 CPU rows
 * on production. The classifier would have been reading a column nothing
 * populates and answering "no usage data" for every tenant on the platform.
 *
 * p95 because a workload that spends 5% of its time above the ceiling is
 * throttled in exactly the moments that matter, and an average hides that
 * completely.
 */
export function tenantUsageBlocker(
  p95Millis: number | null,
  ceiling: number,
): CpuMigrationBlocker | null {
  // Unsampled is not "fits". Treating it as fitting would migrate precisely
  // the tenant nobody has evidence about.
  if (p95Millis === null) return 'no_usage_data';
  if (p95Millis > ceiling * 1000) return 'usage_exceeds_ceiling';
  return null;
}

/**
 * Millicores the re-tier hands back for one deployment.
 *
 * Floors at zero: a deployment whose tier is LARGER than its current request
 * gives nothing back, and counting it as negative would let one under-sized
 * app erase the savings of twenty over-sized ones.
 */
export function reclaimFor(currentMillis: number, proposedMillis: number): number {
  return Math.max(0, currentMillis - proposedMillis);
}

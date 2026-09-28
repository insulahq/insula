/**
 * What CPU a NEW workload asks for (ADR-062 R3).
 *
 * ★ Without this the tier model leaks the moment a tenant deploys again.
 *
 * A migration re-tiers every workload a tenant has, and then the next deploy
 * goes straight back to the catalog's `recommended.cpu` — a quarter-core
 * reservation on a tenant whose whole namespace was just rebuilt around
 * 5–100m shares. The reserved figure the migration brought down climbs back
 * one deployment at a time, invisibly, and the tenant's namespace quota
 * (sized from what it held at migration) refuses the deploy long before the
 * node is anywhere near full.
 *
 * Legacy tenants are untouched: they get the catalog value, exactly as
 * before, because their whole namespace is still sized in reservations.
 */

import { CPU_TIER_MILLICORES, type CpuTier } from '@insula/api-contracts';

import { resolveTenantCpu, type CpuSchedulingMode } from './resolve.js';

export interface NewWorkloadCpuInput {
  /**
   * `recommended.cpu` (falling back to `minimum.cpu`) from the manifest.
   * Used in LEGACY mode only, where a namespace is still sized in
   * reservations and the value still means something.
   */
  readonly catalogCpu: string | null;
  readonly mode: CpuSchedulingMode;
  /** The tenant's resolved tier — what every one of its workloads gets. */
  readonly tenantTier: CpuTier | null;
}

export function newWorkloadCpuRequest(input: NewWorkloadCpuInput): string | null {
  if (input.mode !== 'tiered') return input.catalogCpu;
  // ★ The tenant's tier, for a catalog entry and a custom container alike.
  // The manifest does not get a say: it would be describing a reservation
  // the platform no longer makes, and a third-party repo could hand its
  // entry priority over everything else the tenant runs.
  return `${CPU_TIER_MILLICORES[input.tenantTier ?? 'high']}m`;
}

/** The same decision, from the raw tenant + plan rows most callers hold. */
export function newWorkloadCpuFor(
  plan: { cpuLimit: string | number | null; cpuTier: CpuTier | null; cpuBurstCores: string | number | null } | null,
  tenant: {
    cpuSchedulingMode: string | null;
    cpuLimitOverride: string | number | null;
    cpuTierOverride: CpuTier | null;
    cpuBurstCoresOverride: string | number | null;
  },
  catalogCpu: string | null,
): string | null {
  const mode: CpuSchedulingMode = tenant.cpuSchedulingMode === 'tiered' ? 'tiered' : 'legacy';
  const resolved = resolveTenantCpu(plan, {
    cpuSchedulingMode: mode,
    cpuLimitOverride: tenant.cpuLimitOverride,
    cpuTierOverride: tenant.cpuTierOverride,
    cpuBurstCoresOverride: tenant.cpuBurstCoresOverride,
  });
  return newWorkloadCpuRequest({ catalogCpu, mode, tenantTier: resolved.tier });
}

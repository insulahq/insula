/**
 * What CPU does this tenant actually get? (ADR-062 R2)
 *
 * ONE function answers that, for every caller — the provisioner that writes
 * the ResourceQuota, the panels that display it, and the dry run that
 * previews it. The alternative is what the platform had before: several
 * places each re-deriving a limit from plan + override, disagreeing at the
 * edges, and disagreeing silently.
 *
 * Pure: plan + tenant rows in, numbers out. No I/O, so the precedence rules
 * can be argued with in a test rather than on a cluster.
 */

import { CPU_TIER_MILLICORES, type CpuTier } from '@insula/api-contracts';
import { ceilingCores } from './tiers.js';

export type CpuSchedulingMode = 'legacy' | 'tiered';

/** The plan's CPU grants. Strings because Postgres numerics arrive as strings. */
export interface PlanCpuGrants {
  /** LEGACY: feeds requests.cpu in legacy mode. Not a cap. */
  readonly cpuLimit: string | number | null;
  readonly cpuTier: CpuTier | null;
  readonly cpuBurstCores: string | number | null;
}

export interface TenantCpuOverrides {
  readonly cpuSchedulingMode: CpuSchedulingMode;
  readonly cpuLimitOverride: string | number | null;
  readonly cpuTierOverride: CpuTier | null;
  readonly cpuBurstCoresOverride: string | number | null;
}

export interface ResolvedTenantCpu {
  readonly mode: CpuSchedulingMode;
  /**
   * The tenant-wide `requests.cpu` budget, in millicores.
   *
   * In legacy mode this is the old reservation (cpu_limit, in cores), and it
   * is NEVER null — an unresolvable plan falls back to
   * DEFAULT_LEGACY_CPU_CORES, exactly as every call site this replaces does.
   *
   * In tiered mode it is null, and that is not a fallback failing: there IS
   * no per-tenant request under the tier model. The quota's requests.cpu is
   * the SUM of the workloads' tier values, which the caller computes with
   * tieredQuotaRequestMillis(). Branch on `mode`, never on this being null —
   * the two nulls would mean opposite things if legacy could produce one.
   */
  readonly requestMillis: number | null;
  /** Tiered mode only: the tier each workload defaults to. */
  readonly tier: CpuTier | null;
  /** Tiered mode only: the tenant-wide `limits.cpu` ceiling, in cores. */
  readonly burstCores: number | null;
  /** Where each effective value came from — the panels label this. */
  readonly source: {
    readonly tier: 'tenant_override' | 'plan' | 'default' | null;
    readonly burst: 'tenant_override' | 'plan' | 'derived' | null;
  };
}

/** Postgres numerics arrive as strings; a bad one must not read as 0. */
function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The tier a tenant's workloads take when neither the tenant nor its plan
 * says. `high` rather than `normal`: an unconfigured workload is more likely
 * to be a runtime or a database than a static site, and the cost of guessing
 * too low is a workload that loses every contention race it enters, which
 * reads as "the platform is slow" rather than as a misconfiguration.
 */
export const DEFAULT_TIER: CpuTier = 'high';

/**
 * Cores a legacy tenant gets when neither an override nor a resolvable plan
 * says otherwise.
 *
 * ★ This MUST match resource-quotas/service.ts's DEFAULT_CPU_LIMIT. This
 * function is meant to replace those hand-rolled `?? 2` fallbacks, and a
 * replacement that answers differently from what it replaces is worse than no
 * replacement: a plan-less legacy tenant (DEV has one — nothing declares a
 * foreign key from tenants.plan_id) would come out with a different quota
 * than it has today, for no reason anyone would connect to this change.
 */
export const DEFAULT_LEGACY_CPU_CORES = 2;

export function resolveTenantCpu(
  plan: PlanCpuGrants | null,
  tenant: TenantCpuOverrides,
): ResolvedTenantCpu {
  if (tenant.cpuSchedulingMode === 'legacy') {
    // Legacy reads exactly what it read before this ADR: cores, as a
    // reservation. Nothing here may consult the tier columns — a tenant that
    // has not been migrated must schedule identically to before the upgrade,
    // including on a cluster whose plans were given tiers by an admin.
    const cores = num(tenant.cpuLimitOverride)
      ?? num(plan?.cpuLimit ?? null)
      ?? DEFAULT_LEGACY_CPU_CORES;
    return {
      mode: 'legacy',
      requestMillis: Math.round(cores * 1000),
      tier: null,
      burstCores: null,
      source: { tier: null, burst: null },
    };
  }

  const tier = tenant.cpuTierOverride ?? plan?.cpuTier ?? DEFAULT_TIER;
  const tierSource = tenant.cpuTierOverride != null
    ? 'tenant_override' as const
    : plan?.cpuTier != null ? 'plan' as const : 'default' as const;

  const overrideBurst = num(tenant.cpuBurstCoresOverride);
  const planBurst = num(plan?.cpuBurstCores ?? null);
  /**
   * Derived from the legacy limit only as a LAST resort, so a plan that
   * predates `cpu_burst_cores` still bounds its tenants instead of resolving
   * to "no ceiling". A plan that declares a ceiling never reaches this.
   *
   * ★ The EFFECTIVE limit — `cpu_limit_override ?? plan.cpu_limit` — which
   * is the precedence every other path uses, including this function's own
   * legacy branch ten lines up. It used to read `plan.cpuLimit` alone, so
   * the same tenant resolved two different ways depending on which branch
   * asked: a tenant whose `cpu_limit_override` was 1.00 against an
   * ultimate plan's 2.00 was given a 4-core ceiling derived from the plan,
   * ignoring the override entirely. Seen on production.
   */
  const burstCores = overrideBurst ?? planBurst
    ?? ceilingCores(num(tenant.cpuLimitOverride) ?? num(plan?.cpuLimit ?? null));
  const burstSource = overrideBurst != null
    ? 'tenant_override' as const
    : planBurst != null ? 'plan' as const : 'derived' as const;

  return {
    mode: 'tiered',
    requestMillis: null,
    tier,
    burstCores,
    source: { tier: tierSource, burst: burstSource },
  };
}

/**
 * The `requests.cpu` a tenant's ResourceQuota carries in tiered mode: the sum
 * of its workloads' tier values, not a per-tenant number.
 *
 * A tenant with no workloads sums to 0, which is correct — it reserves
 * nothing — but callers writing a ResourceQuota should apply their own floor
 * rather than emit `requests.cpu: 0`, which forbids scheduling entirely.
 */
export function tieredQuotaRequestMillis(tiers: readonly CpuTier[]): number {
  return tiers.reduce((sum, t) => sum + CPU_TIER_MILLICORES[t], 0);
}

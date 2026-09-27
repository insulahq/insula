import { describe, it, expect } from 'vitest';
import {
  resolveTenantCpu, tieredQuotaRequestMillis, DEFAULT_TIER, DEFAULT_LEGACY_CPU_CORES,
  type PlanCpuGrants, type TenantCpuOverrides,
} from './resolve.js';

const plan = (o: Partial<PlanCpuGrants> = {}): PlanCpuGrants =>
  ({ cpuLimit: '1.00', cpuTier: null, cpuBurstCores: null, ...o });
const tenant = (o: Partial<TenantCpuOverrides> = {}): TenantCpuOverrides =>
  ({ cpuSchedulingMode: 'legacy', cpuLimitOverride: null, cpuTierOverride: null,
     cpuBurstCoresOverride: null, ...o });

describe('resolveTenantCpu — legacy mode', () => {
  it('reads the plan cpu_limit as a reservation, in millicores', () => {
    const r = resolveTenantCpu(plan({ cpuLimit: '2.00' }), tenant());
    expect(r.mode).toBe('legacy');
    expect(r.requestMillis).toBe(2000);
  });

  it('prefers the tenant override', () => {
    const r = resolveTenantCpu(plan({ cpuLimit: '2.00' }), tenant({ cpuLimitOverride: '0.25' }));
    expect(r.requestMillis).toBe(250);
  });

  /**
   * ★ The safety property of the whole migration. An admin may set tiers on a
   * PLAN at any time — while preparing, or by mistake. A tenant that has not
   * been migrated must schedule exactly as it did before the upgrade, so
   * legacy must not read the tier columns at all. If it did, populating a
   * plan would silently re-tier every tenant on it.
   */
  it('IGNORES tier columns entirely, even when the plan sets them', () => {
    const r = resolveTenantCpu(
      plan({ cpuLimit: '2.00', cpuTier: 'normal', cpuBurstCores: '8' }),
      tenant({ cpuTierOverride: 'highest', cpuBurstCoresOverride: '9' }),
    );
    expect(r.requestMillis).toBe(2000);
    expect(r.tier).toBeNull();
    expect(r.burstCores).toBeNull();
  });

  /**
   * ★ Must agree with what it replaces. resource-quotas/service.ts and the
   * dashboard both fall back to 2 cores for a tenant with no override and no
   * resolvable plan; DEV has such a tenant live. Returning null here instead
   * would hand the eventual caller a value their `?? DEFAULT` would turn into
   * something else — or worse, a 0.
   */
  it('falls back to the same 2 cores every existing call site uses', () => {
    const r = resolveTenantCpu(null, tenant());
    expect(r.requestMillis).toBe(DEFAULT_LEGACY_CPU_CORES * 1000);
    expect(r.requestMillis).toBe(2000);
  });

  // The two nulls would mean opposite things; legacy must never produce one.
  it('never returns a null request in legacy mode', () => {
    for (const t of [tenant(), tenant({ cpuLimitOverride: 'garbage' })]) {
      expect(resolveTenantCpu(null, t).requestMillis).not.toBeNull();
    }
  });
});

describe('resolveTenantCpu — tiered mode', () => {
  const tiered = (o: Partial<TenantCpuOverrides> = {}) =>
    tenant({ cpuSchedulingMode: 'tiered', ...o });

  it('takes the tier from the plan and labels the source', () => {
    const r = resolveTenantCpu(plan({ cpuTier: 'normal' }), tiered());
    expect(r.tier).toBe('normal');
    expect(r.source.tier).toBe('plan');
  });

  it('lets a tenant override the plan tier', () => {
    const r = resolveTenantCpu(plan({ cpuTier: 'normal' }), tiered({ cpuTierOverride: 'highest' }));
    expect(r.tier).toBe('highest');
    expect(r.source.tier).toBe('tenant_override');
  });

  it('falls back to the default tier, labelled as such', () => {
    const r = resolveTenantCpu(plan(), tiered());
    expect(r.tier).toBe(DEFAULT_TIER);
    expect(r.source.tier).toBe('default');
  });

  /**
   * requestMillis is null in tiered mode ON PURPOSE. The quota's requests.cpu
   * is the SUM of the workloads' tiers, not a per-tenant figure, and handing
   * back a plausible-looking number here is how a caller would end up writing
   * the legacy reservation into a tiered quota.
   */
  it('refuses to offer a per-tenant request figure', () => {
    expect(resolveTenantCpu(plan({ cpuLimit: '4' }), tiered()).requestMillis).toBeNull();
  });

  it('prefers an explicit plan ceiling over the derived one', () => {
    const r = resolveTenantCpu(plan({ cpuLimit: '1.00', cpuBurstCores: '3.5' }), tiered());
    expect(r.burstCores).toBe(3.5);
    expect(r.source.burst).toBe('plan');
  });

  // A plan migrated before cpu_burst_cores was populated must still bound its
  // tenants — "no ceiling" is the one answer that must never fall out of a gap.
  it('derives a generous ceiling when the plan has none', () => {
    const r = resolveTenantCpu(plan({ cpuLimit: '1.00' }), tiered());
    expect(r.burstCores).toBe(2);
    expect(r.source.burst).toBe('derived');
  });

  it('never derives a ceiling below one core, even for the smallest plan', () => {
    expect(resolveTenantCpu(plan({ cpuLimit: '0.10' }), tiered()).burstCores).toBe(1);
  });

  it('still bounds a tenant whose plan cannot be resolved at all', () => {
    const r = resolveTenantCpu(null, tiered());
    expect(r.burstCores).toBe(1);
    expect(r.tier).toBe(DEFAULT_TIER);
  });

  // Postgres numerics arrive as strings; a malformed one must not read as 0,
  // which would be "reserve nothing" / "no burst".
  it('treats an unparseable numeric as absent, not as zero', () => {
    const r = resolveTenantCpu(plan({ cpuBurstCores: 'not-a-number', cpuLimit: '2' }), tiered());
    expect(r.burstCores).toBe(4);
    expect(r.source.burst).toBe('derived');
  });
});

describe('tieredQuotaRequestMillis', () => {
  it('sums the tier values', () => {
    expect(tieredQuotaRequestMillis(['normal', 'normal', 'high'])).toBe(40);
  });

  // 16 idle static sites: 1600m under the old floor, 80m here. This number is
  // the entire point of the ADR.
  it('collapses a fleet of idle static sites', () => {
    expect(tieredQuotaRequestMillis(Array(16).fill('normal'))).toBe(80);
  });

  it('is 0 for a tenant with no workloads', () => {
    expect(tieredQuotaRequestMillis([])).toBe(0);
  });
});

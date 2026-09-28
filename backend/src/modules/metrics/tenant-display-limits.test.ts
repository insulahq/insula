/**
 * What a tenant's CPU number MEANS, and the bug that made three call sites
 * disagree about it.
 *
 * ★ The columns on TenantCpuRow are REQUIRED on purpose.
 *
 * They were optional, so TypeScript accepted the hourly metrics scheduler's
 * query — which had never selected them. `cpuSchedulingMode` was undefined
 * at runtime for every tenant, every tenant resolved to `legacy`, and a
 * tiered tenant using 0.30 cores was measured against its old 0.25-core
 * reservation and paged an admin with a CRITICAL saturation alert. Hourly.
 * The interactive endpoints were right; the one path that emails a human
 * was wrong.
 */
import { describe, it, expect } from 'vitest';
import { tenantDisplayLimits, tenantDisplayLimitsEnforced } from './tenant-display-limits.js';

const plan = {
  cpuLimit: '0.25', cpuTier: 'normal' as const, cpuBurstCores: null,
  memoryLimit: '1.00', storageLimit: '5.00',
};
const tenant = (o: Partial<Parameters<typeof tenantDisplayLimits>[0]> = {}) => ({
  planId: 'p1',
  cpuLimitOverride: null,
  cpuSchedulingMode: 'legacy' as string | null,
  cpuTierOverride: null,
  cpuBurstCoresOverride: null,
  memoryLimitOverride: null,
  storageLimitOverride: null,
  ...o,
});

describe('tenantDisplayLimits', () => {
  it('gives a LEGACY tenant its plan reservation, labelled as one', () => {
    const l = tenantDisplayLimits(tenant(), plan);
    expect(l).toMatchObject({ cpuLimit: 0.25, cpuKind: 'reserve' });
  });

  it('gives a TIERED tenant its burst ceiling, labelled as consumption', () => {
    // 0.25 derives max(1, 0.5) = 1 core. Measuring usage against 0.25 is
    // what made a machine at 20% read as full.
    const l = tenantDisplayLimits(tenant({ cpuSchedulingMode: 'tiered' }), plan);
    expect(l).toMatchObject({ cpuLimit: 1, cpuKind: 'consume' });
  });

  it('honours a per-tenant ceiling override', () => {
    const l = tenantDisplayLimits(
      tenant({ cpuSchedulingMode: 'tiered', cpuBurstCoresOverride: '4' }), plan,
    );
    expect(l.cpuLimit).toBe(4);
  });

  it('treats an UNSET scheduling mode as legacy, never as tiered', () => {
    // The scheduler's failure was the other direction — reading undefined
    // as legacy for a tiered tenant — but the reverse would be worse: a
    // legacy tenant measured against a ceiling it does not have.
    const l = tenantDisplayLimits(tenant({ cpuSchedulingMode: null }), plan);
    expect(l.cpuKind).toBe('reserve');
  });

  it('falls back to the defaults when there is no plan at all', () => {
    const l = tenantDisplayLimits(tenant(), undefined);
    expect(l).toMatchObject({ cpuLimit: 2, memoryLimitGi: 4, storageLimitGi: 50 });
  });

  it('leaves memory and storage alone in both modes', () => {
    // Memory is incompressible and its limit is real; ADR-062 changes
    // nothing about it.
    const legacy = tenantDisplayLimits(tenant(), plan);
    const tiered = tenantDisplayLimits(tenant({ cpuSchedulingMode: 'tiered' }), plan);
    expect(tiered.memoryLimitGi).toBe(legacy.memoryLimitGi);
    expect(tiered.storageLimitGi).toBe(legacy.storageLimitGi);
  });
});

/**
 * ★ A tenant must be shown what is ENFORCED, not what is saved.
 *
 * ADR-062 says the tenant view carries "two real, enforced numbers".
 * `tenantDisplayLimits` resolves from the database — the SAVED value — and
 * saving is not applying. Caught in a browser on a live tenant whose
 * namespace enforced a 4-core ceiling while the panel told them 2.
 *
 * The harmful direction is a RAISED ceiling that has not been applied: the
 * tenant is told they may burst further than the LimitRange allows, and
 * the throttling that follows contradicts their own usage page.
 */
describe('tenantDisplayLimitsEnforced', () => {
  const plan = {
    cpuLimit: '2.00', cpuTier: 'highest' as const, cpuBurstCores: '4.00',
    memoryLimit: '2.00', storageLimit: '10.00',
  };
  const tiered = (o = {}) => ({
    planId: 'p1', cpuLimitOverride: null, cpuSchedulingMode: 'tiered' as string | null,
    cpuTierOverride: null, cpuBurstCoresOverride: null,
    memoryLimitOverride: null, storageLimitOverride: null, ...o,
  });
  /** A cluster whose LimitRange imposes `cpu`, spelled as the client returns it. */
  const k8sWith = (cpu: string | null) => ({
    core: {
      readNamespacedLimitRange: async () => {
        if (cpu === null) throw Object.assign(new Error('HTTP-Code: 404'), { statusCode: 404 });
        return { spec: { limits: [{ type: 'Container', _default: { cpu } }] } };
      },
    },
  }) as never;

  it('reports the ENFORCED ceiling when it differs from the saved one', async () => {
    const l = await tenantDisplayLimitsEnforced(
      tiered({ cpuBurstCoresOverride: '2' }), plan, k8sWith('4'), 'ns',
    );
    expect(l.cpuLimit).toBe(4);
  });

  it('falls back to the saved value when the namespace has no LimitRange', async () => {
    // Mid-change, or a tenant whose LimitRange is gone. The saved value is
    // the only number there is.
    const l = await tenantDisplayLimitsEnforced(
      tiered({ cpuBurstCoresOverride: '2' }), plan, k8sWith(null), 'ns',
    );
    expect(l.cpuLimit).toBe(2);
  });

  it('leaves a LEGACY tenant alone — its limit is a plan allowance', async () => {
    const l = await tenantDisplayLimitsEnforced(
      tiered({ cpuSchedulingMode: 'legacy' }), plan, k8sWith('4'), 'ns',
    );
    expect(l).toMatchObject({ cpuLimit: 2, cpuKind: 'reserve' });
  });

  it('reads millicores as millicores', async () => {
    const l = await tenantDisplayLimitsEnforced(tiered(), plan, k8sWith('1500m'), 'ns');
    expect(l.cpuLimit).toBe(1.5);
  });

  it('is the saved value when there is no cluster to ask', async () => {
    const l = await tenantDisplayLimitsEnforced(tiered(), plan, undefined, 'ns');
    expect(l.cpuLimit).toBe(4);
  });
});

import { describe, it, expect } from 'vitest';
import {
  buildTieredQuotaHard, buildTenantLimitRange, assessLimitsCpuReadiness,
  QUOTA_LIMITS_CPU_BACKSTOP, MIN_QUOTA_REQUEST_MILLIS,
} from './tiered-namespace.js';

describe('buildTieredQuotaHard', () => {
  it('sums the tiers into requests.cpu', () => {
    const h = buildTieredQuotaHard({ tiers: ['normal', 'normal', 'high'], burstCores: 2, memoryGi: 4 });
    expect(h['requests.cpu']).toBe('40m');
  });

  /**
   * ★ The reason the quota is a LOOSE backstop and not the burst allowance.
   * The quota caps the SUM of declared container limits, and the LimitRange
   * gives every container the FULL allowance as its ceiling. Set them equal
   * and the first pod consumes the entire quota — the tenant's second pod
   * fails admission. This asserts the headroom for more than one pod exists.
   */
  it('leaves room for several pods each holding the full per-container ceiling', () => {
    const burstCores = 2;
    const h = buildTieredQuotaHard({ tiers: ['high'], burstCores, memoryGi: 4 });
    expect(Number(h['limits.cpu'])).toBe(burstCores * QUOTA_LIMITS_CPU_BACKSTOP);
    expect(Number(h['limits.cpu'])).toBeGreaterThan(burstCores);
  });

  // requests.cpu "0" does not mean "reserves nothing", it means nothing can
  // be scheduled — a frozen namespace rather than an empty one.
  it('never emits a zero request for a tenant with no workloads', () => {
    const h = buildTieredQuotaHard({ tiers: [], burstCores: 1, memoryGi: 1 });
    expect(h['requests.cpu']).toBe(`${MIN_QUOTA_REQUEST_MILLIS}m`);
  });

  it('leaves memory as request==limit, unchanged by this ADR', () => {
    const h = buildTieredQuotaHard({ tiers: ['high'], burstCores: 1, memoryGi: 3 });
    expect(h['requests.memory']).toBe('3Gi');
    expect(h['limits.memory']).toBe('3Gi');
  });

  // 16 idle static sites: 1600m before, 80m here. The ADR's headline number.
  it('collapses a fleet of idle static sites', () => {
    const h = buildTieredQuotaHard({ tiers: Array(16).fill('normal'), burstCores: 1, memoryGi: 8 });
    expect(h['requests.cpu']).toBe('80m');
  });
});

describe('buildTenantLimitRange', () => {
  it('defaults an undeclared container to the tier, and caps it at the allowance', () => {
    const lr = buildTenantLimitRange({ namespace: 'tenant-x', tier: 'normal', burstCores: 2 });
    const l = lr.spec.limits[0] as Record<string, Record<string, string>>;
    expect(l.defaultRequest.cpu).toBe('5m');
    expect(l.default.cpu).toBe('2');
    expect(l.max.cpu).toBe('2');
  });

  /**
   * Memory must NOT appear here. Tenant pods run request == limit
   * (Guaranteed) and memory is incompressible; a LimitRange default would
   * collide with that model and an OOM kill is the price of getting it wrong.
   */
  it('says nothing about memory', () => {
    const l = buildTenantLimitRange({ namespace: 'tenant-x', tier: 'high', burstCores: 1 })
      .spec.limits[0] as Record<string, Record<string, string>>;
    expect(l.default.memory).toBeUndefined();
    expect(l.defaultRequest.memory).toBeUndefined();
    expect(l.max.memory).toBeUndefined();
  });
});

/**
 * The sequencing guard. Adding limits.cpu to a quota makes the API server
 * refuse every pod in the namespace that lacks a CPU limit — not immediately,
 * but at the next rollout, eviction or drain, long after the quota edit.
 */
describe('assessLimitsCpuReadiness', () => {
  it('refuses while the namespace has no LimitRange', () => {
    const r = assessLimitsCpuReadiness(false, [], 'tenant-default');
    expect(r.ready).toBe(false);
    expect(r.reason).toContain('no CPU LimitRange');
  });

  /**
   * ★ The tempting shortcut, and why it is wrong. A LimitRange applies at
   * ADMISSION, so it does nothing for pods admitted before it existed. Those
   * pods are the armed trap: fine now, refused at their next recreation.
   */
  it('refuses when the LimitRange exists but a running pod predates it', () => {
    const r = assessLimitsCpuReadiness(true, [
      { podName: 'web-1', containersWithoutCpuLimit: [], priorityClassName: 'tenant-default' },
      { podName: 'worker-7', containersWithoutCpuLimit: ['worker'], priorityClassName: 'tenant-default' },
    ], 'tenant-default');
    expect(r.ready).toBe(false);
    expect(r.reason).toContain('recreated first');
    // Named, so the operator knows what to cycle rather than guessing.
    expect(r.blockingPods).toEqual(['worker-7']);
  });

  it('allows it once the LimitRange exists and every pod carries a limit', () => {
    const r = assessLimitsCpuReadiness(true, [
      { podName: 'web-1', containersWithoutCpuLimit: [], priorityClassName: 'tenant-default' },
      { podName: 'db-0', containersWithoutCpuLimit: [], priorityClassName: 'tenant-default' },
    ], 'tenant-default');
    expect(r.ready).toBe(true);
    expect(r.reason).toBeNull();
  });

  /**
   * ★ The quota is scoped to `PriorityClass In [tenant-default]`, so it never
   * constrains platform pods that share the namespace at
   * `platform-tenant-overhead` — file-manager runs there with a CPU request
   * and NO limit, deliberately. Judging it here would block migration for
   * any tenant whose File Manager happens to be running, intermittently and
   * for a reason Kubernetes would never enforce.
   */
  it('ignores platform pods the quota does not govern', () => {
    const r = assessLimitsCpuReadiness(true, [
      { podName: 'web-1', containersWithoutCpuLimit: [], priorityClassName: 'tenant-default' },
      { podName: 'file-manager-abc', containersWithoutCpuLimit: ['file-manager'], priorityClassName: 'platform-tenant-overhead' },
    ], 'tenant-default');
    expect(r.ready).toBe(true);
    expect(r.blockingPods).toEqual([]);
  });

  // A pod with no class at all is not in scope either.
  it('ignores a pod with no priority class', () => {
    const r = assessLimitsCpuReadiness(true, [
      { podName: 'stray', containersWithoutCpuLimit: ['x'], priorityClassName: null },
    ], 'tenant-default');
    expect(r.ready).toBe(true);
  });

  // An empty namespace is ready — there is nothing to break.
  it('allows it for a namespace with no pods', () => {
    expect(assessLimitsCpuReadiness(true, [], 'tenant-default').ready).toBe(true);
  });
});

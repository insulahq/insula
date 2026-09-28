import { describe, it, expect } from 'vitest';
import {
  buildTieredQuotaHard, buildTenantLimitRange, assessLimitsCpuReadiness,
  QUOTA_LIMITS_CPU_BACKSTOP, MIN_QUOTA_REQUEST_MILLIS,
} from './tiered-namespace.js';

const quota = (o: Partial<Parameters<typeof buildTieredQuotaHard>[0]> = {}) =>
  buildTieredQuotaHard({
    tiers: ['high'], burstCores: 2,
    liveUsedMillis: 0, largestPodMillis: 0, ...o,
  });

describe('buildTieredQuotaHard', () => {
  it('sums the tiers into requests.cpu, plus surge room', () => {
    // 5+5+30 = 40, plus a 100m surge floor.
    const h = quota({ tiers: ['normal', 'normal', 'high'] });
    expect(h['requests.cpu']).toBe('140m');
  });

  /**
   * ★ MEASURED on a live cluster, and the reason liveUsedMillis exists.
   *
   * Kubernetes ACCEPTS a ResourceQuota whose hard is below current used — it
   * does not reject the update — and then refuses EVERY subsequent pod:
   *   "exceeded quota … requested: requests.cpu=5m, used: 300m, limited: 30m"
   * even for a 5m pod. The tier sum covers only what the migration re-tiered,
   * so a tenant with a CPU-pinning container or a compose stack would have
   * had its namespace frozen by its own migration.
   */
  it('never sets requests.cpu below what the namespace already holds', () => {
    const h = quota({ tiers: ['normal'], liveUsedMillis: 2000, largestPodMillis: 500 });
    // 2000 held + 500 surge, not the 5m the tier sum alone would give.
    expect(Number(h['requests.cpu'].replace('m', ''))).toBe(2500);
  });

  /**
   * Steady state exactly equal to the quota is not enough: a rolling update
   * runs the old and the new pod together. Without surge the namespace is
   * not frozen but nothing can ever roll.
   */
  it('leaves room for one more copy of the biggest workload', () => {
    const h = quota({ tiers: ['high'], liveUsedMillis: 30, largestPodMillis: 800 });
    expect(Number(h['requests.cpu'].replace('m', ''))).toBe(830);
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
    const h = quota({ tiers: ['high'], burstCores });
    expect(Number(h['limits.cpu'])).toBe(burstCores * QUOTA_LIMITS_CPU_BACKSTOP);
    expect(Number(h['limits.cpu'])).toBeGreaterThan(burstCores);
  });

  // requests.cpu "0" does not mean "reserves nothing", it means nothing can
  // be scheduled — a frozen namespace rather than an empty one.
  it('never emits a zero request for a tenant with no workloads', () => {
    const h = quota({ tiers: [], burstCores: 1 });
    expect(Number(h['requests.cpu'].replace('m', ''))).toBeGreaterThanOrEqual(MIN_QUOTA_REQUEST_MILLIS);
  });

  /**
   * ★ The patch must not mention memory at all. Re-stating a value we have no
   * reason to change bought nothing and risked everything: a quota whose
   * memory is expressed in Mi would have parsed to NaN, coalesced to 0, and
   * written `0Gi` — freezing the namespace on MEMORY during a CPU migration.
   */
  it('says nothing about memory, so a merge patch cannot disturb it', () => {
    const h = quota({ tiers: ['high'], burstCores: 1 });
    expect(Object.keys(h).sort()).toEqual(['limits.cpu', 'requests.cpu']);
  });

  // 16 idle static sites: 1600m before, 80m here. The ADR's headline number.
  it('collapses a fleet of idle static sites', () => {
    const h = quota({ tiers: Array(16).fill('normal'), burstCores: 1, liveUsedMillis: 80 });
    // 80m of tiers + the 100m surge floor — against 1600m before.
    expect(Number(h['requests.cpu'].replace('m', ''))).toBe(180);
  });
});

describe('buildTenantLimitRange', () => {
  it('defaults an undeclared container to the tier, and caps it at the allowance', () => {
    const lr = buildTenantLimitRange({ namespace: 'tenant-x', tier: 'normal', burstCores: 2, largestDeclaredMillis: 0 });
    const l = lr.spec.limits[0] as Record<string, Record<string, string>>;
    expect(l.defaultRequest.cpu).toBe('5m');
    expect(l.default.cpu).toBe('2');
    expect(l.max.cpu).toBe('2');
  });

  /**
   * ★ MEASURED on a live cluster: a LimitRange `max.cpu` rejects a container
   * REQUESTING more than it —
   *   "spec.containers[0].resources.requests: Invalid value: \"2\":
   *    must be less than or equal to cpu limit of 1"
   * — so installing one at the burst ceiling makes an existing larger
   * workload unschedulable. The straggler sweep would then delete such a pod
   * and be unable to recreate it: an outage caused by the migration.
   */
  it('raises max to cover a container that already declares more', () => {
    const l = buildTenantLimitRange({
      namespace: 'tenant-x', tier: 'high', burstCores: 1, largestDeclaredMillis: 2000,
    }).spec.limits[0] as Record<string, Record<string, string>>;
    expect(l.max.cpu).toBe('2');
    // The POLICY bound is unchanged — only what may be declared moves.
    expect(l.default.cpu).toBe('1');
  });

  it('keeps max at the ceiling when nothing declares more', () => {
    const l = buildTenantLimitRange({
      namespace: 'tenant-x', tier: 'high', burstCores: 2, largestDeclaredMillis: 500,
    }).spec.limits[0] as Record<string, Record<string, string>>;
    expect(l.max.cpu).toBe('2');
  });

  /**
   * Memory must NOT appear here. Tenant pods run request == limit
   * (Guaranteed) and memory is incompressible; a LimitRange default would
   * collide with that model and an OOM kill is the price of getting it wrong.
   */
  it('says nothing about memory', () => {
    const l = buildTenantLimitRange({ namespace: 'tenant-x', tier: 'high', burstCores: 1, largestDeclaredMillis: 0 })
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
      { podName: 'web-1', containersWithoutCpuLimit: [], priorityClassName: 'tenant-default' , hasController: true },
      { podName: 'worker-7', containersWithoutCpuLimit: ['worker'], priorityClassName: 'tenant-default' , hasController: true },
    ], 'tenant-default');
    expect(r.ready).toBe(false);
    expect(r.reason).toContain('recreated first');
    // Named, so the operator knows what to cycle rather than guessing.
    expect(r.blockingPods).toEqual(['worker-7']);
  });

  it('allows it once the LimitRange exists and every pod carries a limit', () => {
    const r = assessLimitsCpuReadiness(true, [
      { podName: 'web-1', containersWithoutCpuLimit: [], priorityClassName: 'tenant-default' , hasController: true },
      { podName: 'db-0', containersWithoutCpuLimit: [], priorityClassName: 'tenant-default' , hasController: true },
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
      { podName: 'web-1', containersWithoutCpuLimit: [], priorityClassName: 'tenant-default' , hasController: true },
      { podName: 'file-manager-abc', containersWithoutCpuLimit: ['file-manager'], priorityClassName: 'platform-tenant-overhead' , hasController: true },
    ], 'tenant-default');
    expect(r.ready).toBe(true);
    expect(r.blockingPods).toEqual([]);
  });

  // A pod with no class at all is not in scope either.
  it('ignores a pod with no priority class', () => {
    const r = assessLimitsCpuReadiness(true, [
      { podName: 'stray', containersWithoutCpuLimit: ['x'], priorityClassName: null , hasController: true },
    ], 'tenant-default');
    expect(r.ready).toBe(true);
  });

  // An empty namespace is ready — there is nothing to break.
  it('allows it for a namespace with no pods', () => {
    expect(assessLimitsCpuReadiness(true, [], 'tenant-default').ready).toBe(true);
  });
});

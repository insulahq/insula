import { describe, it, expect } from 'vitest';
import {
  buildTieredQuotaHard, buildTenantLimitRange, assessLimitsCpuReadiness,
  podsWithStaleCeiling, type PodCpuLimitFact, MIN_QUOTA_REQUEST_MILLIS,
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
  /**
   * ★ The quota must never carry a CPU ceiling again.
   *
   * It charges each container its whole ceiling at admission, so a budget of
   * N ceilings is a cap of N containers. On production it stopped a starter
   * tenant at two applications and then blocked every rolling replacement,
   * its own migration included. The per-container ceiling in the LimitRange
   * is what bounds a noisy neighbour, and that is untouched.
   */
  it('never writes a CPU ceiling, whatever the burst allowance is', () => {
    for (const burstCores of [0.5, 1, 2, 4, 16]) {
      const h = quota({ tiers: ['high'], burstCores });
      expect(h['limits.cpu']).toBeUndefined();
    }
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
    expect(Object.keys(h)).toEqual(['requests.cpu']);
  });

  // 16 idle static sites: 1600m before, 80m here. The ADR's headline number.
  it('collapses a fleet of idle static sites', () => {
    const h = quota({ tiers: Array(16).fill('normal'), burstCores: 1, liveUsedMillis: 80 });
    // 80m of tiers + the 100m surge floor — against 1600m before.
    expect(Number(h['requests.cpu'].replace('m', ''))).toBe(180);
  });
});

describe('buildTenantLimitRange', () => {
  /**
   * ★ The ceiling key is `_default`, and that is not a typo to tidy up.
   *
   * The Kubernetes JS client renames the reserved word: `_default` on the
   * model serialises to `default` on the wire, and a plain `default` is not
   * a model field at all — the client drops it and returns 201, leaving a
   * LimitRange with a request and NO ceiling. Measured against a live API
   * server; `kubectl get` on the result showed `default: {cpu: 2}` only for
   * the `_default` form.
   *
   * It survived unnoticed while a `max` was also being written, because
   * that carried the ceiling along with it. Removing `max` removed the
   * ceiling too — so this assertion is the one that would have caught it.
   */
  it('defaults an undeclared container to the tier and the ceiling', () => {
    const lr = buildTenantLimitRange({ namespace: 'tenant-x', tier: 'normal', burstCores: 2 });
    const l = lr.spec.limits[0] as Record<string, Record<string, string>>;
    expect(l.defaultRequest.cpu).toBe('5m');
    expect(l._default.cpu).toBe('2');
    expect(l.default).toBeUndefined();
  });

  /**
   * ★ A LimitRange polices EVERY container in the namespace, and a tenant
   * namespace is not only the tenant's. The platform's file-backup Job runs
   * there and declares 1.5 cores, so a `max` of 1 refused it — "maximum cpu
   * usage per Container is 1, but limit is 1500m" — and the Job retried to
   * its 29-minute deadline and died. Twenty-four of thirty-one namespaces
   * stopped backing up their files, reported as `partial` because every
   * other component of the backup succeeded.
   */
  it('sets no max, so a platform job may declare more than the ceiling', () => {
    for (const burstCores of [0.5, 1, 2, 6]) {
      const l = buildTenantLimitRange({ namespace: 'tenant-x', tier: 'high', burstCores })
        .spec.limits[0] as Record<string, Record<string, string>>;
      expect(l.max).toBeUndefined();
      // The bound that matters is untouched: anything declaring no CPU limit
      // still gets the ceiling, which is every application a tenant deploys.
      expect(l._default.cpu).toBe(String(burstCores));
    }
  });

  /**
   * Memory must NOT appear here. Tenant pods run request == limit
   * (Guaranteed) and memory is incompressible; a LimitRange default would
   * collide with that model and an OOM kill is the price of getting it wrong.
   */
  it('says nothing about memory', () => {
    const l = buildTenantLimitRange({ namespace: 'tenant-x', tier: 'high', burstCores: 1 })
      .spec.limits[0] as Record<string, Record<string, string>>;
    expect(l._default.memory).toBeUndefined();
    expect(l.defaultRequest.memory).toBeUndefined();
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
      { podName: 'web-1', containersWithoutCpuLimit: [], containerCpuLimitsMillis: [2000], priorityClassName: 'tenant-default' , hasController: true },
      { podName: 'worker-7', containersWithoutCpuLimit: ['worker'], containerCpuLimitsMillis: [2000], priorityClassName: 'tenant-default' , hasController: true },
    ], 'tenant-default');
    expect(r.ready).toBe(false);
    expect(r.reason).toContain('recreated first');
    // Named, so the operator knows what to cycle rather than guessing.
    expect(r.blockingPods).toEqual(['worker-7']);
  });

  it('allows it once the LimitRange exists and every pod carries a limit', () => {
    const r = assessLimitsCpuReadiness(true, [
      { podName: 'web-1', containersWithoutCpuLimit: [], containerCpuLimitsMillis: [2000], priorityClassName: 'tenant-default' , hasController: true },
      { podName: 'db-0', containersWithoutCpuLimit: [], containerCpuLimitsMillis: [2000], priorityClassName: 'tenant-default' , hasController: true },
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
      { podName: 'web-1', containersWithoutCpuLimit: [], containerCpuLimitsMillis: [2000], priorityClassName: 'tenant-default' , hasController: true },
      { podName: 'file-manager-abc', containersWithoutCpuLimit: ['file-manager'], containerCpuLimitsMillis: [2000], priorityClassName: 'platform-tenant-overhead' , hasController: true },
    ], 'tenant-default');
    expect(r.ready).toBe(true);
    expect(r.blockingPods).toEqual([]);
  });

  // A pod with no class at all is not in scope either.
  it('ignores a pod with no priority class', () => {
    const r = assessLimitsCpuReadiness(true, [
      { podName: 'stray', containersWithoutCpuLimit: ['x'], containerCpuLimitsMillis: [2000], priorityClassName: null , hasController: true },
    ], 'tenant-default');
    expect(r.ready).toBe(true);
  });

  // An empty namespace is ready — there is nothing to break.
  it('allows it for a namespace with no pods', () => {
    expect(assessLimitsCpuReadiness(true, [], 'tenant-default').ready).toBe(true);
  });
});

describe('buildTieredQuotaHard — the limit axis', () => {
  /**
   * ★ The same lesson as requests.cpu, on the other axis.
   *
   * `limits.cpu` was sized purely as burst x BACKSTOP, which assumes a
   * tenant never runs more than BACKSTOP containers at the ceiling. A tenant
   * with five does — and Kubernetes ACCEPTS a quota below `used`, then
   * refuses every later pod. Re-applying a REDUCED ceiling walks into it by
   * construction: the pods still hold the old, larger limits.
   */
  /**
   * The three tests that used to live here checked the ceiling arithmetic —
   * backstop versus what the pods already hold. Both branches produced a cap
   * on the container count; the fix was to stop writing the key, so what is
   * worth asserting now is that no input resurrects it.
   */
  it('emits no ceiling however large the live limits are', () => {
    const hard = buildTieredQuotaHard({
      tiers: ['normal'], burstCores: 1, liveUsedMillis: 10, largestPodMillis: 10,
    });
    expect(hard['limits.cpu']).toBeUndefined();
    expect(Object.keys(hard)).toEqual(['requests.cpu']);
  });

});

describe('podsWithStaleCeiling', () => {
  const pod = (o: Partial<PodCpuLimitFact>): PodCpuLimitFact => ({
    podName: 'p', containersWithoutCpuLimit: [], priorityClassName: 'tenant-default',
    hasController: true, containerCpuLimitsMillis: [1000], ...o,
  });

  it('finds a pod carrying the previous ceiling', () => {
    expect(podsWithStaleCeiling([pod({ podName: 'old' })], 'tenant-default', 1000)).toEqual(['old']);
  });

  it('leaves a container that declares its own, different limit', () => {
    // Its limit did not come from the LimitRange, so replacing the pod
    // brings back exactly the same thing.
    expect(podsWithStaleCeiling([pod({ containerCpuLimitsMillis: [1500] })], 'tenant-default', 1000)).toEqual([]);
  });

  it('never names a pod nothing would recreate', () => {
    expect(podsWithStaleCeiling([pod({ hasController: false })], 'tenant-default', 1000)).toEqual([]);
  });

  it('ignores pods the quota does not govern', () => {
    expect(podsWithStaleCeiling([pod({ priorityClassName: 'platform-tenant-overhead' })], 'tenant-default', 1000)).toEqual([]);
  });

  it('leaves a limitless pod to the readiness check, which BLOCKS on it', () => {
    // Folding the two together would turn a blocking condition into a
    // silent deletion.
    expect(podsWithStaleCeiling(
      [pod({ containersWithoutCpuLimit: ['web'], containerCpuLimitsMillis: [] })], 'tenant-default', 1000,
    )).toEqual([]);
  });

  it('does nothing when there was no previous ceiling', () => {
    expect(podsWithStaleCeiling([pod({})], 'tenant-default', null)).toEqual([]);
  });
});

describe('assessLimitsCpuReadiness — the re-apply case', () => {
  const pod = (o: Partial<PodCpuLimitFact>): PodCpuLimitFact => ({
    podName: 'p', containersWithoutCpuLimit: [], priorityClassName: 'tenant-default',
    hasController: true, containerCpuLimitsMillis: [1000], ...o,
  });

  /**
   * ★ The silent failure of a re-apply.
   *
   * The sweep skips a pod with no controller — correctly, deleting one
   * destroys the workload — and this check used to pass it, because it does
   * have *a* limit. The run reported `completed` while that pod went on
   * running at the old, higher ceiling, and the panel reported the new
   * ceiling as applied because the panel reads the LimitRange.
   */
  it('REFUSES when a controller-less pod still carries the previous ceiling', () => {
    const r = assessLimitsCpuReadiness(
      true, [pod({ podName: 'bare', hasController: false })], 'tenant-default', 1000,
    );
    expect(r.ready).toBe(false);
    expect(r.blockingPods).toEqual(['bare']);
    expect(r.reason).toMatch(/no controller/i);
  });

  it('allows one that something WILL recreate — the sweep handles it', () => {
    expect(assessLimitsCpuReadiness(
      true, [pod({ hasController: true })], 'tenant-default', 1000,
    ).ready).toBe(true);
  });

  it('allows a controller-less pod already on the NEW ceiling', () => {
    expect(assessLimitsCpuReadiness(
      true, [pod({ hasController: false, containerCpuLimitsMillis: [2000] })], 'tenant-default', 1000,
    ).ready).toBe(true);
  });

  it('ignores the whole question on a first migration', () => {
    // No previous ceiling to be stuck on.
    expect(assessLimitsCpuReadiness(
      true, [pod({ hasController: false })], 'tenant-default', null,
    ).ready).toBe(true);
  });

  it('still refuses a limitless pod first — that check comes before this one', () => {
    const r = assessLimitsCpuReadiness(
      true,
      [pod({ podName: 'nolimit', containersWithoutCpuLimit: ['web'], containerCpuLimitsMillis: [] })],
      'tenant-default', 1000,
    );
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/no CPU limit/i);
  });
});

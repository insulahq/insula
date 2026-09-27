import { describe, it, expect, vi } from 'vitest';
import { buildRevertPlan, runTenantCpuRevert, type RevertibleDeployment, type RevertEffects } from './revert.js';

const d = (o: Partial<RevertibleDeployment> = {}): RevertibleDeployment => ({
  id: 'd1', name: 'app', currentCpuRequest: '5m', cpuRequestPreMigration: '0.25', ...o,
});

describe('buildRevertPlan', () => {
  /**
   * ★ Restore, never recompute. The stored string goes back verbatim: "0.25"
   * must not come back as "250m". They schedule identically, but the operator
   * never asked for that field to change, and a revert that rewrites what it
   * claims to restore cannot be trusted with the things that do matter.
   */
  it('restores the stored string exactly, not an equivalent', () => {
    const p = buildRevertPlan([d({ cpuRequestPreMigration: '0.25' })]);
    expect(p.steps[0].toCpuRequest).toBe('0.25');
  });

  it('leaves a never-migrated deployment alone', () => {
    const p = buildRevertPlan([d({ name: 'fresh', cpuRequestPreMigration: null })]);
    expect(p.steps).toEqual([]);
    expect(p.untouched).toEqual(['fresh']);
  });

  // Re-running a revert must not churn pods a second time.
  it('is idempotent when the value is already back', () => {
    const p = buildRevertPlan([d({ currentCpuRequest: '0.25', cpuRequestPreMigration: '0.25' })]);
    expect(p.steps).toEqual([]);
    expect(p.untouched).toEqual(['app']);
  });

  /**
   * An empty stored baseline is the one case where the promise cannot be
   * kept. Guessing a value here is worse than saying so: the operator would
   * get a deployment back with a number nobody chose and no signal.
   */
  it('reports an unhonourable baseline instead of inventing one', () => {
    const p = buildRevertPlan([d({ name: 'broken', cpuRequestPreMigration: '  ' })]);
    expect(p.steps).toEqual([]);
    expect(p.unrestorable).toEqual([{ name: 'broken', reason: 'stored prior request is empty' }]);
  });
});

function effects(over: Partial<RevertEffects> = {}) {
  const calls: string[] = [];
  const fx: RevertEffects = {
    restore: vi.fn(async (id) => { calls.push(`restore:${id}`); }),
    removeQuotaLimits: vi.fn(async () => { calls.push('quota-off'); }),
    removeLimitRange: vi.fn(async () => { calls.push('limitrange-off'); }),
    markLegacy: vi.fn(async () => { calls.push('legacy'); }),
    report: vi.fn(async () => {}),
    ...over,
  };
  return { fx, calls };
}

describe('runTenantCpuRevert', () => {
  /**
   * ★ The ceiling comes off FIRST. While `limits.cpu` is on the quota it caps
   * the sum of declared container limits — so restoring a workload to its
   * LARGER original request can be refused for exceeding a ceiling the
   * migration itself installed. A revert must not be blocked by its own
   * leftovers.
   */
  it('removes the quota ceiling before restoring anything', async () => {
    const { fx, calls } = effects();
    await runTenantCpuRevert(fx, buildRevertPlan([d({ id: 'a' }), d({ id: 'b', name: 'b' })]));
    expect(calls[0]).toBe('quota-off');
    expect(calls.indexOf('quota-off')).toBeLessThan(calls.indexOf('restore:a'));
  });

  // …and the LimitRange comes off LAST, so pods recreated during the restore
  // still inherit a ceiling instead of briefly having none.
  it('removes the LimitRange only after the restores', async () => {
    const { fx, calls } = effects();
    await runTenantCpuRevert(fx, buildRevertPlan([d({ id: 'a' })]));
    expect(calls).toEqual(['quota-off', 'restore:a', 'limitrange-off', 'legacy']);
  });

  it('reports how far it got when a restore throws', async () => {
    let n = 0;
    const { fx, calls } = effects({
      restore: vi.fn(async (id) => { if (++n === 2) throw new Error('conflict'); calls.push(`restore:${id}`); }),
    });
    const r = await runTenantCpuRevert(fx, buildRevertPlan([
      d({ id: 'a' }), d({ id: 'b', name: 'b' }), d({ id: 'c', name: 'c' }),
    ]));
    expect(r).toMatchObject({ status: 'failed', reason: 'conflict', restored: 1 });
    // Still legacy-shaped, and NOT falsely marked legacy before finishing.
    expect(calls).not.toContain('legacy');
  });

  it('surfaces the count it could not restore', async () => {
    const { fx } = effects();
    const r = await runTenantCpuRevert(fx, buildRevertPlan([
      d({ id: 'a' }), d({ id: 'x', name: 'x', cpuRequestPreMigration: '' }),
    ]));
    expect(r).toMatchObject({ status: 'completed', restored: 1, unrestorable: 1 });
  });

  // Reverting a tenant that never migrated must still clean up the namespace
  // objects — a failed migration can leave a LimitRange behind.
  it('still tears down the namespace objects when nothing needs restoring', async () => {
    const { fx, calls } = effects();
    const r = await runTenantCpuRevert(fx, buildRevertPlan([d({ cpuRequestPreMigration: null })]));
    expect(r.status).toBe('completed');
    expect(calls).toEqual(['quota-off', 'limitrange-off', 'legacy']);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { runTenantCpuMigration, type MigrationEffects } from './apply.js';
import type { DeploymentToRetier } from './plan.js';
import type { WorkloadReadiness } from './health-gate.js';

const healthy: WorkloadReadiness[] = [{ name: 'app', desiredReplicas: 1, readyReplicas: 1, failureMessage: null }];

const dep = (o: Partial<DeploymentToRetier> = {}): DeploymentToRetier => ({
  id: 'd1', name: 'app', currentCpuRequest: '0.25', proposedTier: 'normal', pinsOwnCpu: false,
  containerCount: 1, isComposeStack: false, ...o,
});

function effects(over: Partial<MigrationEffects> = {}) {
  const calls: string[] = [];
  const fx: MigrationEffects = {
    retier: vi.fn(async (id) => { calls.push(`retier:${id}`); }),
    recreatePods: vi.fn(async (id) => { calls.push(`recreate:${id}`); }),
    ensureLimitRange: vi.fn(async () => { calls.push('limitrange'); }),
    limitRangeExists: vi.fn(async () => true),
    readWorkloads: vi.fn(async () => healthy),
    readPodCpuLimits: vi.fn(async () => [
      { podName: 'app-1', containersWithoutCpuLimit: [], priorityClassName: 'tenant-default' },
    ]),
    quotaScopePriorityClass: 'tenant-default',
    applyQuotaLimits: vi.fn(async () => { calls.push('quota'); }),
    markTiered: vi.fn(async () => { calls.push('tiered'); }),
    report: vi.fn(async () => {}),
    stopRequested: vi.fn(async () => false),
    sleep: vi.fn(async () => {}),
    now: () => 0,
    ...over,
  };
  return { fx, calls };
}

describe('runTenantCpuMigration', () => {
  it('runs the whole sequence and reports what it freed', async () => {
    const { fx, calls } = effects();
    const r = await runTenantCpuMigration(fx, {
      namespace: 'tenant-a', tier: 'normal', burstCores: 2,
      deployments: [dep({ currentCpuRequest: '0.25', proposedTier: 'normal' })],
    });
    expect(r.status).toBe('completed');
    expect(r).toMatchObject({ freedMillis: 245 }); // 250 - 5
    expect(calls).toEqual(['limitrange', 'retier:d1', 'quota', 'tiered']);
  });

  /**
   * ★ The ordering that makes a half-finished migration safe. The quota
   * ceiling is the ONLY step that can hurt the tenant later (a namespace
   * whose quota demands limits its pods do not declare), so it goes last —
   * after every pod has been recreated with one.
   */
  it('never touches the quota before the workloads are recreated', async () => {
    const { fx, calls } = effects();
    await runTenantCpuMigration(fx, {
      namespace: 'tenant-a', tier: 'normal', burstCores: 2,
      deployments: [dep({ id: 'a' }), dep({ id: 'b', name: 'b' })],
    });
    expect(calls.indexOf('quota')).toBeGreaterThan(calls.indexOf('retier:b'));
    expect(calls.indexOf('tiered')).toBe(calls.length - 1);
  });

  it('waits for health between each workload', async () => {
    const readWorkloads = vi.fn(async () => healthy);
    const { fx } = effects({ readWorkloads });
    await runTenantCpuMigration(fx, {
      namespace: 'tenant-a', tier: 'normal', burstCores: 2,
      deployments: [dep({ id: 'a' }), dep({ id: 'b', name: 'b' })],
    });
    expect(readWorkloads).toHaveBeenCalledTimes(2);
  });

  /**
   * ★ A stop must leave the tenant BETWEEN steps, never mid-effect, and must
   * not have marked it tiered. Everything done so far is a smaller request
   * than before, which is strictly easier to schedule — so a stopped
   * migration is a safe resting state, not a broken one.
   */
  it('stops between steps, leaving the tenant in legacy mode', async () => {
    let n = 0;
    const { fx, calls } = effects({ stopRequested: vi.fn(async () => (++n > 2)) });
    const r = await runTenantCpuMigration(fx, {
      namespace: 'tenant-a', tier: 'normal', burstCores: 2,
      deployments: [dep({ id: 'a' }), dep({ id: 'b', name: 'b' })],
    });
    expect(r.status).toBe('stopped');
    expect(calls).not.toContain('tiered');
    expect(calls).not.toContain('quota');
  });

  // A quota rejection mid-migration must halt, not push on through.
  it('fails fast when a workload comes back broken', async () => {
    const { fx, calls } = effects({
      readWorkloads: vi.fn(async () => [
        { name: 'app', desiredReplicas: 1, readyReplicas: 0, failureMessage: 'exceeded quota' },
      ]),
    });
    const r = await runTenantCpuMigration(fx, {
      namespace: 'tenant-a', tier: 'normal', burstCores: 2,
      deployments: [dep({ id: 'a' }), dep({ id: 'b', name: 'b' })],
    });
    expect(r.status).toBe('failed');
    expect(r).toMatchObject({ reason: expect.stringContaining('exceeded quota') });
    expect(calls).not.toContain('retier:b'); // did NOT continue
    expect(calls).not.toContain('tiered');
  });

  /**
   * ★ Stopping SHORT of the quota rather than forcing it. Everything up to
   * here is a pure improvement; adding limits.cpu over a pod with no limit
   * arms a failure that surfaces at some unrelated rollout days later.
   */
  it('refuses the quota ceiling when a pod still has no CPU limit', async () => {
    const { fx, calls } = effects({
      readPodCpuLimits: vi.fn(async () => [
        { podName: 'old-1', containersWithoutCpuLimit: ['web'], priorityClassName: 'tenant-default' },
      ]),
    });
    const r = await runTenantCpuMigration(fx, {
      namespace: 'tenant-a', tier: 'normal', burstCores: 2, deployments: [dep()],
    });
    expect(r.status).toBe('failed');
    expect(r).toMatchObject({ reason: expect.stringContaining('old-1') });
    expect(calls).not.toContain('quota');
    expect(calls).not.toContain('tiered');
  });

  it('reports a retier that throws instead of continuing', async () => {
    const { fx, calls } = effects({
      retier: vi.fn(async () => { throw new Error('admission webhook denied'); }),
    });
    const r = await runTenantCpuMigration(fx, {
      namespace: 'tenant-a', tier: 'normal', burstCores: 2, deployments: [dep()],
    });
    expect(r.status).toBe('failed');
    expect(r).toMatchObject({ reason: 'admission webhook denied' });
    expect(calls).not.toContain('quota');
  });

  // A tenant with nothing to re-tier still gets the LimitRange, the ceiling
  // and the flag — otherwise it is "migrated" in name only.
  it('migrates a tenant that has no deployments', async () => {
    const { fx, calls } = effects();
    const r = await runTenantCpuMigration(fx, {
      namespace: 'tenant-a', tier: 'normal', burstCores: 1, deployments: [],
    });
    expect(r.status).toBe('completed');
    expect(calls).toEqual(['limitrange', 'quota', 'tiered']);
  });

  // The quota's requests.cpu is the sum of the tiers actually applied, so a
  // deployment left alone must not be counted into it.
  it('excludes a CPU-pinning deployment from the quota sum', async () => {
    const applyQuotaLimits = vi.fn(async () => {});
    const { fx } = effects({ applyQuotaLimits });
    await runTenantCpuMigration(fx, {
      namespace: 'tenant-a', tier: 'normal', burstCores: 2,
      deployments: [dep({ id: 'a' }), dep({ id: 'byo', name: 'byo', pinsOwnCpu: true })],
    });
    expect(applyQuotaLimits).toHaveBeenCalledWith(2, ['normal']);
  });

  /**
   * ★ The quota budgets per CONTAINER, not per deployments row. The
   * LimitRange applies defaultRequest to every container it admits, so a row
   * scheduling three of them consumes three tier values. Budgeting per row
   * would under-provision the quota and the tenant's own later pods would be
   * refused against a ceiling we set.
   */
  it('budgets the quota per container, not per deployment row', async () => {
    const applyQuotaLimits = vi.fn(async () => {});
    const { fx } = effects({ applyQuotaLimits });
    await runTenantCpuMigration(fx, {
      namespace: 'tenant-a', tier: 'normal', burstCores: 2,
      deployments: [dep({ id: 'a', containerCount: 3 })],
    });
    expect(applyQuotaLimits).toHaveBeenCalledWith(2, ['normal', 'normal', 'normal']);
  });

  /**
   * ★ The dead-end the review caught. A deployment already at its tier gets
   * no template change, so nothing rolls and its pods keep running without a
   * limit — verify_limits_ready would then refuse forever. It must be
   * recreated instead of skipped.
   */
  it('recreates an already-at-tier deployment so it can gain a limit', async () => {
    const { fx, calls } = effects();
    const r = await runTenantCpuMigration(fx, {
      namespace: 'tenant-a', tier: 'normal', burstCores: 2,
      deployments: [dep({ id: 'same', currentCpuRequest: '5m', proposedTier: 'normal' })],
    });
    expect(r.status).toBe('completed');
    expect(calls).toContain('recreate:same');
    expect(calls.indexOf('recreate:same')).toBeLessThan(calls.indexOf('quota'));
  });

  // Every effect gets the same typed-outcome contract, not just retier.
  it.each([
    ['ensureLimitRange', 'limitrange denied'],
    ['applyQuotaLimits', 'quota patch rejected'],
    ['markTiered', 'db write failed'],
    ['limitRangeExists', 'api unreachable'],
  ])('turns a throwing %s into a typed failure, not a rejection', async (name, msg) => {
    const { fx } = effects({ [name]: vi.fn(async () => { throw new Error(msg); }) } as never);
    const r = await runTenantCpuMigration(fx, {
      namespace: 'tenant-a', tier: 'normal', burstCores: 2, deployments: [dep()],
    });
    expect(r.status).toBe('failed');
    expect(r).toMatchObject({ reason: msg });
  });

  // The LimitRange is verified, not assumed, before the ceiling goes on.
  it('refuses the ceiling when the LimitRange is not actually there', async () => {
    const { fx, calls } = effects({ limitRangeExists: vi.fn(async () => false) });
    const r = await runTenantCpuMigration(fx, {
      namespace: 'tenant-a', tier: 'normal', burstCores: 2, deployments: [dep()],
    });
    expect(r.status).toBe('failed');
    expect(r).toMatchObject({ reason: expect.stringContaining('no CPU LimitRange') });
    expect(calls).not.toContain('quota');
  });
});

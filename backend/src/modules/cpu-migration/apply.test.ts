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
  // A clock that ADVANCES. A frozen one (now: () => 0) is not a simplification
  // here — the health gate now rides out a transient failure for a grace
  // period, so with time standing still a persistent failure never ages past
  // it and the loop spins forever. The fake has to be able to reach the
  // deadline the code is written against.
  let t = 0;
  const fx: MigrationEffects = {
    retier: vi.fn(async (id) => { calls.push(`retier:${id}`); }),
    recreatePods: vi.fn(async (id) => { calls.push(`recreate:${id}`); }),
    widenQuotaHeadroom: vi.fn(async () => { calls.push('widen'); }),
    ensureLimitRange: vi.fn(async () => { calls.push('limitrange'); }),
    limitRangeExists: vi.fn(async () => true),
    readWorkloads: vi.fn(async () => healthy),
    readPodCpuLimits: vi.fn(async () => [
      { podName: 'app-1', containersWithoutCpuLimit: [], priorityClassName: 'tenant-default' , hasController: true },
    ]),
    deletePods: vi.fn(async (names: readonly string[]) => { calls.push(`delete:${names.join('+')}`); }),
    quotaScopePriorityClass: 'tenant-default',
    applyQuotaLimits: vi.fn(async () => { calls.push('quota'); }),
    markTiered: vi.fn(async () => { calls.push('tiered'); }),
    report: vi.fn(async () => {}),
    stopRequested: vi.fn(async () => false),
    sleep: vi.fn(async (ms: number) => { t += ms; }),
    now: () => t,
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
    expect(calls).toEqual(['widen', 'limitrange', 'retier:d1', 'quota', 'tiered']);
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
        { podName: 'old-1', containersWithoutCpuLimit: ['web'], priorityClassName: 'tenant-default' , hasController: true },
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
    expect(calls).toEqual(['widen', 'limitrange', 'quota', 'tiered']);
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

  /**
   * ★ The gap the DEV run found. Every other step is driven by `deployments`
   * rows; the readiness check is driven by LIVE PODS. On DEV a deployment was
   * `stopped` in the database while its pod was 1/1 in the cluster — so the
   * plan never touched it, it never gained a limit, and the migration could
   * never pass. This step asks the same source the gate asks.
   */
  it('replaces a live pod the deployments table never mentioned', async () => {
    let seen = 0;
    const { fx, calls } = effects({
      readPodCpuLimits: vi.fn(async () => {
        seen += 1;
        // First read: an orphan with no limit. After the delete: clean.
        return seen === 1
          ? [{ podName: 'ghost-1', containersWithoutCpuLimit: ['db'], priorityClassName: 'tenant-default' , hasController: true }]
          : [{ podName: 'ghost-2', containersWithoutCpuLimit: [], priorityClassName: 'tenant-default' , hasController: true }];
      }),
    });
    const r = await runTenantCpuMigration(fx, {
      namespace: 'tenant-a', tier: 'normal', burstCores: 2, deployments: [dep()],
    });
    expect(r.status).toBe('completed');
    expect(calls).toContain('delete:ghost-1');
    expect(calls.indexOf('delete:ghost-1')).toBeLessThan(calls.indexOf('quota'));
  });

  // It must not churn pods that already comply.
  it('deletes nothing when every in-scope pod already has a ceiling', async () => {
    const { fx, calls } = effects();
    await runTenantCpuMigration(fx, {
      namespace: 'tenant-a', tier: 'normal', burstCores: 2, deployments: [dep()],
    });
    expect(calls.some((c) => c.startsWith('delete:'))).toBe(false);
  });

  // A platform pod outside the quota's scope is not ours to restart.
  it('leaves out-of-scope pods alone even when they lack a ceiling', async () => {
    const { fx, calls } = effects({
      readPodCpuLimits: vi.fn(async () => [
        { podName: 'file-manager-1', containersWithoutCpuLimit: ['fm'], priorityClassName: 'platform-tenant-overhead' , hasController: true },
      ]),
    });
    const r = await runTenantCpuMigration(fx, {
      namespace: 'tenant-a', tier: 'normal', burstCores: 2, deployments: [dep()],
    });
    expect(r.status).toBe('completed');
    expect(calls.some((c) => c.startsWith('delete:'))).toBe(false);
  });

  /**
   * ★ Refuse rather than destroy. The sweep DELETES pods; a pod with no
   * controller is not recreated by anything, so deleting it is permanent
   * loss of that workload. Production has none today, but the failure mode
   * is unrecoverable while refusing to migrate is not.
   */
  it('never deletes a pod that nothing would recreate', async () => {
    const { fx, calls } = effects({
      readPodCpuLimits: vi.fn(async () => [
        { podName: 'orphan', containersWithoutCpuLimit: ['c'], priorityClassName: 'tenant-default', hasController: false },
      ]),
    });
    const r = await runTenantCpuMigration(fx, {
      namespace: 'tenant-a', tier: 'normal', burstCores: 2, deployments: [dep()],
    });
    expect(calls.some((c) => c.startsWith('delete:'))).toBe(false);
    // …and it stops short of the ceiling, naming the pod.
    expect(r.status).toBe('failed');
    expect(r).toMatchObject({ reason: expect.stringContaining('orphan') });
    expect(calls).not.toContain('quota');
  });

  /**
   * ★ The order that keeps a tight cluster safe. On a node at 98% reserved,
   * a re-tier REDUCES the request, so the replacement pod is smaller than
   * the one it replaces and always fits. The no-gain recreations, which surge
   * at the SAME size, come after — by which point the re-tiers have freed
   * room for them. Reversing this spends the scarcest moment on the pods that
   * need the most headroom.
   */
  it('frees room with the shrinking pods before surging the same-size ones', async () => {
    const { fx, calls } = effects();
    await runTenantCpuMigration(fx, {
      namespace: 'tenant-a', tier: 'normal', burstCores: 2,
      deployments: [
        dep({ id: 'same', name: 'same', currentCpuRequest: '5m', proposedTier: 'normal' }),
        dep({ id: 'big', name: 'big', currentCpuRequest: '2', proposedTier: 'normal' }),
      ],
    });
    expect(calls.indexOf('retier:big')).toBeLessThan(calls.indexOf('recreate:same'));
  });

  /**
   * ★ The quota is widened BEFORE any pod is touched. A Terminating pod holds
   * its full reservation for its grace period, and the legacy quota has zero
   * slack, so without this the very first replacement is refused by the
   * tenant's own quota — with the old pod already deleted.
   */
  it('makes quota room before the first pod is replaced', async () => {
    const { fx, calls } = effects();
    await runTenantCpuMigration(fx, {
      namespace: 'tenant-a', tier: 'normal', burstCores: 2, deployments: [dep()],
    });
    expect(calls[0]).toBe('widen');
    expect(calls.indexOf('widen')).toBeLessThan(calls.indexOf('retier:d1'));
  });

  it('reports a failure to widen rather than replacing pods anyway', async () => {
    const { fx, calls } = effects({
      widenQuotaHeadroom: vi.fn(async () => { throw new Error('quota patch denied'); }),
    });
    const r = await runTenantCpuMigration(fx, {
      namespace: 'tenant-a', tier: 'normal', burstCores: 2, deployments: [dep()],
    });
    expect(r.status).toBe('failed');
    expect(calls.some((c) => c.startsWith('retier:'))).toBe(false);
  });
});

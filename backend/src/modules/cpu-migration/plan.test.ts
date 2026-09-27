import { describe, it, expect } from 'vitest';
import { buildMigrationPlan, cpuRequestToMillis, type DeploymentToRetier } from './plan.js';

const dep = (o: Partial<DeploymentToRetier> = {}): DeploymentToRetier => ({
  id: 'd1', name: 'app', currentCpuRequest: '0.25', proposedTier: 'high', pinsOwnCpu: false,
  containerCount: 1, isComposeStack: false, ...o,
});

describe('cpuRequestToMillis', () => {
  it('reads both shapes the column has carried', () => {
    expect(cpuRequestToMillis('0.25')).toBe(250);
    expect(cpuRequestToMillis('250m')).toBe(250);
    expect(cpuRequestToMillis('2')).toBe(2000);
  });

  // An unparseable value must be distinguishable from zero — treating it as 0
  // would compute a saving that does not exist and revert to the wrong value.
  it('returns null for anything it cannot parse, never 0', () => {
    for (const v of ['', '  ', 'abc', '1.5.2', '100Mi', null, undefined]) {
      expect(cpuRequestToMillis(v as string)).toBeNull();
    }
  });
});

describe('buildMigrationPlan', () => {
  it('brackets the re-tiers with the LimitRange first and the quota last', () => {
    const p = buildMigrationPlan({ namespace: 'tenant-a', deployments: [dep()], defaultTier: 'high' });
    const kinds = p.steps.map((s) => s.kind);
    expect(kinds[0]).toBe('ensure_limit_range');
    expect(kinds.slice(-3)).toEqual(['verify_limits_ready', 'apply_quota_limits', 'mark_tiered']);
  });

  /**
   * ★ Ordering is a safety property, not cosmetics. Migration is SELF-EASING:
   * each re-tier hands CPU back, making the next recreation easier to
   * schedule. On a cluster tight enough for the first recreation to be risky,
   * the biggest over-reserver must go FIRST — it buys the most headroom at
   * the moment headroom is scarcest. The instinct to "start with something
   * small" spends the whole migration in the tightest state.
   */
  it('orders the biggest saving first', () => {
    const p = buildMigrationPlan({
      namespace: 'tenant-a',
      defaultTier: 'high',
      deployments: [
        dep({ id: 'small', name: 'small', currentCpuRequest: '0.05', proposedTier: 'normal' }),
        dep({ id: 'huge', name: 'huge', currentCpuRequest: '2', proposedTier: 'normal' }),
        dep({ id: 'mid', name: 'mid', currentCpuRequest: '0.5', proposedTier: 'normal' }),
      ],
    });
    expect(p.steps.filter((s) => s.kind === 'retier_deployment').map((s) => s.deploymentName))
      .toEqual(['huge', 'mid', 'small']);
  });

  it('reports what the whole tenant hands back', () => {
    const p = buildMigrationPlan({
      namespace: 'tenant-a',
      defaultTier: 'normal',
      deployments: [
        dep({ id: 'a', name: 'a', currentCpuRequest: '0.1', proposedTier: 'normal' }),
        dep({ id: 'b', name: 'b', currentCpuRequest: '0.1', proposedTier: 'normal' }),
      ],
    });
    expect(p.totalFreesMillis).toBe(190); // 2 x (100 - 5)
  });

  // A value a human chose is not ours to overwrite, even downward.
  it('skips a deployment that pins its own CPU, and says why', () => {
    const p = buildMigrationPlan({
      namespace: 'tenant-a', defaultTier: 'high',
      deployments: [dep({ name: 'byo', pinsOwnCpu: true })],
    });
    expect(p.steps.some((s) => s.kind === 'retier_deployment')).toBe(false);
    expect(p.skipped).toEqual([{ name: 'byo', reason: 'declares its own CPU resources' }]);
  });

  /**
   * Exact revert is the whole safety story. If the current value cannot be
   * parsed we cannot promise to put it back, so we do not touch it — better a
   * tenant that stays legacy than one that cannot be restored.
   */
  it('skips a deployment whose current request it cannot parse', () => {
    const p = buildMigrationPlan({
      namespace: 'tenant-a', defaultTier: 'high',
      deployments: [dep({ name: 'weird', currentCpuRequest: 'lots' })],
    });
    expect(p.steps.some((s) => s.kind === 'retier_deployment')).toBe(false);
    expect(p.skipped[0].reason).toContain('unrecognised');
  });

  /**
   * ★ A deployment already AT its tier still needs its pods replaced.
   *
   * Skipping it entirely was a dead end: the LimitRange defaults a limit at
   * ADMISSION, so pods already running never gain one, and an unchanged
   * request means an identical pod template, so nothing rolls. Those pods
   * then fail verify_limits_ready forever, with no step able to fix it.
   * The platform's own compose default is 100m — exactly the `highest` tier
   * value — so this is the common case, not an edge one.
   */
  it('recreates a deployment already at its tier instead of skipping it', () => {
    const p = buildMigrationPlan({
      namespace: 'tenant-a', defaultTier: 'high',
      deployments: [dep({ currentCpuRequest: '30m', proposedTier: 'high' })],
    });
    expect(p.steps.some((s) => s.kind === 'retier_deployment')).toBe(false);
    const rec = p.steps.find((s) => s.kind === 'recreate_deployment');
    expect(rec?.deploymentName).toBe('app');
    expect(rec?.freesMillis).toBe(0);      // re-admits; hands nothing back
    expect(p.skipped).toEqual([]);
    expect(p.totalFreesMillis).toBe(0);
  });

  // The platform's own custom-deployment default, verbatim.
  it('recreates a 100m deployment landing on the highest tier', () => {
    const p = buildMigrationPlan({
      namespace: 'tenant-a', defaultTier: 'highest',
      deployments: [dep({ currentCpuRequest: '100m', proposedTier: 'highest' })],
    });
    expect(p.steps.some((s) => s.kind === 'recreate_deployment')).toBe(true);
  });

  // Recreations free nothing, so they must not displace the savings.
  it('puts the savings before the no-gain recreations', () => {
    const p = buildMigrationPlan({
      namespace: 'tenant-a', defaultTier: 'high',
      deployments: [
        dep({ id: 'same', name: 'same', currentCpuRequest: '30m', proposedTier: 'high' }),
        dep({ id: 'big', name: 'big', currentCpuRequest: '2', proposedTier: 'high' }),
      ],
    });
    const kinds = p.steps.map((s) => s.kind);
    expect(kinds.indexOf('retier_deployment')).toBeLessThan(kinds.indexOf('recreate_deployment'));
  });

  // One row, N services, no unambiguous per-service mapping back — the same
  // reason dispatchCustomResources refuses these.
  it('skips a compose stack and says why', () => {
    const p = buildMigrationPlan({
      namespace: 'tenant-a', defaultTier: 'high',
      deployments: [dep({ name: 'stack', isComposeStack: true })],
    });
    expect(p.steps.some((s) => s.kind.endsWith('_deployment'))).toBe(false);
    expect(p.skipped[0].reason).toContain('compose stack');
  });

  // A tenant with nothing to re-tier still needs the LimitRange, the quota
  // ceiling and the mode flag — otherwise it is "migrated" in name only.
  it('still runs the bracketing steps for a tenant with no deployments', () => {
    const p = buildMigrationPlan({ namespace: 'tenant-a', deployments: [], defaultTier: 'high' });
    expect(p.steps.map((s) => s.kind))
      .toEqual(['ensure_limit_range', 'verify_limits_ready', 'apply_quota_limits', 'mark_tiered']);
  });

  it('records the exact prior value on each step, for revert', () => {
    const p = buildMigrationPlan({
      namespace: 'tenant-a', defaultTier: 'high',
      deployments: [dep({ currentCpuRequest: '0.25', proposedTier: 'normal' })],
    });
    const step = p.steps.find((s) => s.kind === 'retier_deployment');
    expect(step?.fromCpuRequest).toBe('0.25');
    expect(step?.toCpuRequest).toBe('5m');
  });
});

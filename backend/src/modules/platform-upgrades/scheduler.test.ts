import { describe, it, expect, vi } from 'vitest';
import { reconcileUpgradeOnce, type UpgradeReconcilerDeps } from './scheduler.js';
import type { PostflightState } from './collect-postflight.js';

function state(verdict: PostflightState['verdict'], consecutiveFailures = 0): PostflightState {
  return {
    phase: verdict === 'healthy' ? 'healthy' : verdict === 'idle' ? 'idle' : 'reconciling',
    verdict, consecutiveFailures, abortThreshold: 3, pendingVersion: '2026.6.9', runningVersion: '2026.6.2',
    gates: [{ id: 'version-converged', label: 'Running version matches target', status: 'fail', detail: 'x' }],
    ok: verdict === 'healthy', failures: 1, warnings: 0, lastCheckedAt: '2026-06-03T00:00:00Z', environment: 'production',
  };
}

function deps(over: Partial<UpgradeReconcilerDeps> & { observed?: PostflightState; prevVerdict?: string; pending?: string | null }): {
  deps: UpgradeReconcilerDeps; observe: ReturnType<typeof vi.fn>; notifyStuck: ReturnType<typeof vi.fn>;
} {
  const observe = vi.fn(async () => over.observed ?? state('reconciling', 1));
  const notifyStuck = vi.fn(async () => {});
  return {
    deps: {
      getPending: async () => (over.pending === undefined ? '2026.6.9' : over.pending),
      readPrevVerdict: async () => over.prevVerdict ?? 'reconciling',
      observe,
      notifyStuck,
      ...over,
    },
    observe,
    notifyStuck,
  };
}

describe('reconcileUpgradeOnce', () => {
  it('no upgrade in flight → dormant no-op, observe never called', async () => {
    const { deps: d, observe } = deps({ pending: null });
    const r = await reconcileUpgradeOnce(d, 1000);
    expect(r.acted).toBe(false);
    expect(r.notified).toBe(false);
    expect(observe).not.toHaveBeenCalled();
  });

  it('empty-string pending also reads as dormant', async () => {
    const { deps: d, observe } = deps({ pending: '   ' });
    const r = await reconcileUpgradeOnce(d, 1000);
    expect(r.acted).toBe(false);
    expect(observe).not.toHaveBeenCalled();
  });

  it('still reconciling → advances, does NOT notify', async () => {
    const { deps: d, notifyStuck } = deps({ observed: state('reconciling', 2), prevVerdict: 'reconciling' });
    const r = await reconcileUpgradeOnce(d, 1000);
    expect(r.acted).toBe(true);
    expect(r.verdict).toBe('reconciling');
    expect(r.notified).toBe(false);
    expect(notifyStuck).not.toHaveBeenCalled();
  });

  it('TRANSITION into abort-recommended → notifies once', async () => {
    const { deps: d, notifyStuck } = deps({ observed: state('abort-recommended', 3), prevVerdict: 'reconciling' });
    const r = await reconcileUpgradeOnce(d, 1000);
    expect(r.notified).toBe(true);
    expect(notifyStuck).toHaveBeenCalledTimes(1);
  });

  it('already abort-recommended (no transition) → does NOT re-notify', async () => {
    const { deps: d, notifyStuck } = deps({ observed: state('abort-recommended', 4), prevVerdict: 'abort-recommended' });
    const r = await reconcileUpgradeOnce(d, 1000);
    expect(r.notified).toBe(false);
    expect(notifyStuck).not.toHaveBeenCalled();
  });

  it('converged healthy → acted, no notify (runPostflight clears pending)', async () => {
    const { deps: d, notifyStuck } = deps({ observed: state('healthy', 0), prevVerdict: 'reconciling' });
    const r = await reconcileUpgradeOnce(d, 1000);
    expect(r.acted).toBe(true);
    expect(r.verdict).toBe('healthy');
    expect(notifyStuck).not.toHaveBeenCalled();
  });
});

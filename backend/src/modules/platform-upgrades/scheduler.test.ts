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

interface Over {
  observed?: PostflightState;   // what observe() (slow streak advance) returns
  converged?: PostflightState;  // what checkConvergence() (fast pass) returns
  prevVerdict?: string;
  pending?: string | null;
  streakDue?: boolean;
}

function deps(over: Over) {
  const observe = vi.fn(async () => over.observed ?? state('reconciling', 1));
  const checkConvergence = vi.fn(async () => over.converged ?? state('reconciling', 0));
  const notifyStuck = vi.fn(async () => {});
  const finalizeConverged = vi.fn(async () => {});
  const liveProgress = vi.fn(async () => ({ pct: 50, atTarget: 1, total: 2 }));
  const updateProgress = vi.fn(async () => {});
  const dueForStreak = vi.fn(async () => over.streakDue ?? false);
  const d: UpgradeReconcilerDeps = {
    getPending: async () => (over.pending === undefined ? '2026.6.9' : over.pending),
    readPrevVerdict: async () => over.prevVerdict ?? 'reconciling',
    observe,
    notifyStuck,
    finalizeConverged,
    liveProgress,
    updateProgress,
    checkConvergence,
    dueForStreak,
  };
  return { deps: d, observe, checkConvergence, notifyStuck, finalizeConverged, liveProgress, updateProgress, dueForStreak };
}

describe('reconcileUpgradeOnce', () => {
  it('no upgrade in flight → dormant no-op; nothing observed or written', async () => {
    const { deps: d, observe, checkConvergence, updateProgress } = deps({ pending: null });
    const r = await reconcileUpgradeOnce(d, 1000);
    expect(r.acted).toBe(false);
    expect(r.notified).toBe(false);
    expect(observe).not.toHaveBeenCalled();
    expect(checkConvergence).not.toHaveBeenCalled();
    expect(updateProgress).not.toHaveBeenCalled();
  });

  it('empty-string pending also reads as dormant', async () => {
    const { deps: d, checkConvergence } = deps({ pending: '   ' });
    const r = await reconcileUpgradeOnce(d, 1000);
    expect(r.acted).toBe(false);
    expect(checkConvergence).not.toHaveBeenCalled();
  });

  it('in flight → writes live progress to the task every tick', async () => {
    const { deps: d, liveProgress, updateProgress } = deps({ converged: state('reconciling', 0) });
    await reconcileUpgradeOnce(d, 1000);
    expect(liveProgress).toHaveBeenCalledWith('2026.6.9');
    expect(updateProgress).toHaveBeenCalledWith('2026.6.9', 50, '1/2 services on 2026.6.9');
  });

  it('still reconciling, streak NOT due → no observe/streak, no notify', async () => {
    const { deps: d, observe, notifyStuck } = deps({ converged: state('reconciling', 0), streakDue: false });
    const r = await reconcileUpgradeOnce(d, 1000);
    expect(r.acted).toBe(true);
    expect(r.verdict).toBe('reconciling');
    expect(observe).not.toHaveBeenCalled();       // fast tick does not advance the streak
    expect(notifyStuck).not.toHaveBeenCalled();
  });

  it('still reconciling, streak DUE → advances via observe, no notify', async () => {
    const { deps: d, observe, notifyStuck } = deps({ converged: state('reconciling', 0), observed: state('reconciling', 2), streakDue: true });
    const r = await reconcileUpgradeOnce(d, 1000);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(r.verdict).toBe('reconciling');
    expect(notifyStuck).not.toHaveBeenCalled();
  });

  it('TRANSITION into abort-recommended (streak due) → notifies once', async () => {
    const { deps: d, notifyStuck } = deps({
      converged: state('reconciling', 0), observed: state('abort-recommended', 3), prevVerdict: 'reconciling', streakDue: true,
    });
    const r = await reconcileUpgradeOnce(d, 1000);
    expect(r.notified).toBe(true);
    expect(notifyStuck).toHaveBeenCalledTimes(1);
  });

  it('already abort-recommended (no transition) → does NOT re-notify', async () => {
    const { deps: d, notifyStuck } = deps({
      converged: state('reconciling', 0), observed: state('abort-recommended', 4), prevVerdict: 'abort-recommended', streakDue: true,
    });
    const r = await reconcileUpgradeOnce(d, 1000);
    expect(r.notified).toBe(false);
    expect(notifyStuck).not.toHaveBeenCalled();
  });

  it('converged healthy on the fast pass → finalizes immediately, no observe, no notify', async () => {
    const { deps: d, observe, notifyStuck, finalizeConverged } = deps({ converged: state('healthy', 0), prevVerdict: 'reconciling' });
    const r = await reconcileUpgradeOnce(d, 1000);
    expect(r.acted).toBe(true);
    expect(r.verdict).toBe('healthy');
    expect(observe).not.toHaveBeenCalled();        // healthy detected without the slow streak pass
    expect(notifyStuck).not.toHaveBeenCalled();
    expect(finalizeConverged).toHaveBeenCalledWith('2026.6.9');
  });
});

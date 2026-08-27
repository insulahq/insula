/**
 * The parsing here has to survive three benign cases without any of them looking
 * like a broken migration chain — a node that has never converged, an older
 * reconciler that predates the relay, and a malformed snapshot. Getting that
 * wrong would make the panel cry wolf on every fresh install, which is the
 * fastest way to get an alert ignored.
 */
import { describe, it, expect } from 'vitest';
import { interpretNodeSnapshot, isDegraded } from './host-migration-status.js';

const snap = (hostMigrations: unknown) => JSON.stringify({ node: 'n1', hostMigrations });

describe('interpretNodeSnapshot', () => {
  it('reports a node that has never reported at all, without inventing failures', () => {
    const r = interpretNodeSnapshot('n1', undefined);
    expect(r.failedCount).toBe(0);
    expect(r.items).toEqual([]);
    expect(r.note).toMatch(/no report/i);
  });

  it('treats an older reconciler (no hostMigrations key) as "not reported", not "healthy"', () => {
    const r = interpretNodeSnapshot('n1', JSON.stringify({ node: 'n1', sysctls: [] }));
    expect(r.note).toMatch(/not reported/i);
    expect(r.collectedAt).toBeNull();
  });

  it('does not throw on a malformed snapshot', () => {
    const r = interpretNodeSnapshot('n1', '{not json');
    expect(r.note).toMatch(/unreadable/i);
  });

  it('surfaces a failed migration with its cause, attempt count and age', () => {
    const r = interpretNodeSnapshot('n1', snap({
      collectedAt: '2026-08-05T20:00:00Z', mode: 'enforce', source: 'embedded', ok: false, appliedCount: 3,
      items: [{ key: '2026.7.1/0001-a.sh', state: 'run-failed', error: 'schema rejects runtimeClassName', attempt: 840, failingSince: '2026-07-01' }],
    }));
    expect(r.failedCount).toBe(1);
    expect(r.items[0]).toMatchObject({
      state: 'run-failed', error: 'schema rejects runtimeClassName', attempt: 840, failingSince: '2026-07-01',
    });
  });

  it('counts blocked migrations — the thing that made DEV invisible for five weeks', () => {
    const r = interpretNodeSnapshot('n1', snap({
      items: [
        { key: 'v/0001.sh', state: 'run-failed', error: 'boom' },
        { key: 'v/0002.sh', state: 'blocked' },
        { key: 'v/0003.sh', state: 'blocked' },
        { key: 'v/0004.sh', state: 'skipped', skipReason: 'stale values, cleared by hand' },
        { key: 'v/0005.sh', state: 'would-run' },
      ],
    }));
    expect([r.failedCount, r.blockedCount, r.skippedCount, r.pendingCount]).toEqual([1, 2, 1, 1]);
    expect(r.items[3]?.skipReason).toMatch(/cleared by hand/);
  });

  it('RECOUNTS rather than trusting relayed counters', () => {
    // A stale or older relay must not be able to claim "0 failed" while shipping
    // a failed item — the API is what the UI renders.
    const r = interpretNodeSnapshot('n1', snap({
      failedCount: 0, blockedCount: 0,
      items: [{ key: 'v/0001.sh', state: 'run-failed', error: 'boom' }],
    }));
    expect(r.failedCount).toBe(1);
  });

  it('drops items with an unknown state instead of rendering garbage', () => {
    const r = interpretNodeSnapshot('n1', snap({
      items: [{ key: 'v/0001.sh', state: 'wat' }, { key: 'v/0002.sh', state: 'applied' }],
    }));
    expect(r.items.map((i) => i.key)).toEqual(['v/0002.sh']);
  });

  it('surfaces a WHOLE-RUN refusal, which arrives with ok:false and NO items', () => {
    // runHostMigrations refuses outright when the catalog exceeds MAX_SCRIPTS:
    // ok:false, items:[], reason:"…". Every count is legitimately zero, so if
    // the reason is dropped the node renders as a healthy "0 applied" while
    // running nothing at all — the same invisible failure one level up.
    const r = interpretNodeSnapshot('n1', snap({
      ok: false, appliedCount: 0, items: [],
      reason: 'host-migration catalog has 700 scripts (> 500 cap) — refusing',
    }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/> 500 cap/);
    expect(isDegraded([r])).toBe(true);
  });

  it('reports CUMULATIVE applied state, not just what ran in this pass', () => {
    // The relay's appliedCount only counts scripts that actually ran this pass;
    // an already-applied one never reaches the counter. A caught-up node
    // therefore relays 0, and "0 applied" on screen is indistinguishable from
    // "never ran anything" — the exact ambiguity this feature removes.
    const r = interpretNodeSnapshot('n1', snap({
      appliedCount: 0,
      items: [
        { key: 'v/0001.sh', state: 'already-applied' },
        { key: 'v/0002.sh', state: 'already-applied' },
        { key: 'v/0003.sh', state: 'applied' },
      ],
    }));
    expect(r.appliedCount).toBe(3);
  });

  it('honours a relayed count the truncated item list can no longer prove', () => {
    // The relay caps items to stay under the ConfigMap limit and drops applied
    // ones first, deriving counts BEFORE the cap. Recounting alone would then
    // under-report; max() keeps it honest.
    const r = interpretNodeSnapshot('n1', snap({
      failedCount: 9, appliedCount: 250,
      items: [{ key: 'v/0001.sh', state: 'run-failed', error: 'boom' }],
    }));
    expect(r.failedCount).toBe(9);
    expect(r.appliedCount).toBe(250);
  });

  it('counts an invalid script — it will NEVER run, and is silent otherwise', () => {
    const r = interpretNodeSnapshot('n1', snap({
      items: [{ key: 'v/00x-bad.sh', state: 'invalid' }],
    }));
    expect(r.invalidCount).toBe(1);
    expect(isDegraded([r])).toBe(true);
  });
});

describe('isDegraded', () => {
  const base = {
    node: 'n', collectedAt: null, mode: null, source: null, ok: null,
    appliedCount: 0, failedCount: 0, blockedCount: 0, pendingCount: 0, skippedCount: 0,
    invalidCount: 0, reason: null, items: [],
  };
  it('is false for a healthy fleet', () => {
    expect(isDegraded([{ ...base }, { ...base, appliedCount: 5 }])).toBe(false);
  });
  it('is true when ANY node has a failure', () => {
    expect(isDegraded([{ ...base }, { ...base, failedCount: 1 }])).toBe(true);
  });
  it('is true when a node is merely BLOCKED — the silent case', () => {
    expect(isDegraded([{ ...base, blockedCount: 3 }])).toBe(true);
  });
  it('is true for a whole-run refusal, where every count is zero', () => {
    expect(isDegraded([{ ...base, ok: false, reason: 'catalog over cap' }])).toBe(true);
  });
  it('is true for an invalid script that can never run', () => {
    expect(isDegraded([{ ...base, invalidCount: 1 }])).toBe(true);
  });
  it('is NOT degraded merely because migrations are pending', () => {
    // Pending is normal between a release and the next converge.
    expect(isDegraded([{ ...base, pendingCount: 4 }])).toBe(false);
  });
});

/**
 * The case this whole state exists for: a node whose converge timer was never
 * installed relays a snapshot with NO hostMigrations, forever. It used to read
 * as "has not reported yet", which is why the production cluster sat two weeks
 * with an empty migration ledger while every page showed green.
 *
 * The grace window is what keeps that honest in both directions — silent for a
 * fresh node still inside its first hourly converge, loud once it has provably
 * missed one.
 */
describe('never-converged detection', () => {
  const FRESH = 10 * 60 * 1000; // 10 min old
  const OLD = 26 * 60 * 60 * 1000; // 26 h old
  const noMigrations = JSON.stringify({ node: 'n1', sysctls: [] });

  it('stays quiet for a FRESH node with no converge yet', () => {
    const r = interpretNodeSnapshot('n1', noMigrations, FRESH);
    expect(r.neverConverged).toBeFalsy();
    expect(isDegraded([r])).toBe(false);
    expect(r.note).toMatch(/not reported .* yet/i);
  });

  it('flags an OLD node that has still never converged', () => {
    const r = interpretNodeSnapshot('n1', noMigrations, OLD);
    expect(r.neverConverged).toBe(true);
    expect(isDegraded([r])).toBe(true);
    expect(r.note).toMatch(/never converged/i);
  });

  it('gives an old never-converged node runnable fix steps', () => {
    const r = interpretNodeSnapshot('n1', noMigrations, OLD);
    expect(r.remediation?.length ?? 0).toBeGreaterThan(0);
    // The operator must be told where to run it and what actually repairs it.
    expect(r.remediation?.join('\n')).toMatch(/self-upgrade/);
    expect(r.remediation?.join('\n')).toMatch(/list-timers/);
  });

  it('flags an OLD node the reconciler never publishes for, separately', () => {
    const r = interpretNodeSnapshot('n1', undefined, OLD);
    expect(r.reconcilerMissing).toBe(true);
    expect(r.neverConverged).toBeFalsy();
    expect(isDegraded([r])).toBe(true);
    expect(r.remediation?.join('\n')).toMatch(/host-config-reconciler/);
  });

  it('stays quiet for a fresh node the reconciler has not published for yet', () => {
    const r = interpretNodeSnapshot('n1', undefined, FRESH);
    expect(r.reconcilerMissing).toBeFalsy();
    expect(isDegraded([r])).toBe(false);
  });

  it('gives the benefit of the doubt when the node age is unknown', () => {
    // No node list (RBAC, API blip) must not turn every node red.
    const r = interpretNodeSnapshot('n1', noMigrations, undefined);
    expect(r.neverConverged).toBeFalsy();
    expect(isDegraded([r])).toBe(false);
  });

  it('does not flag a node that HAS converged, however old', () => {
    const healthy = JSON.stringify({
      node: 'n1',
      hostMigrations: { ok: true, appliedCount: 24, items: [] },
    });
    const r = interpretNodeSnapshot('n1', healthy, OLD);
    expect(r.neverConverged).toBeFalsy();
    expect(isDegraded([r])).toBe(false);
  });
});

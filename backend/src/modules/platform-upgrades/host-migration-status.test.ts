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
});

describe('isDegraded', () => {
  const base = {
    node: 'n', collectedAt: null, mode: null, source: null, ok: null,
    appliedCount: 0, failedCount: 0, blockedCount: 0, pendingCount: 0, skippedCount: 0, items: [],
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
  it('is NOT degraded merely because migrations are pending', () => {
    // Pending is normal between a release and the next converge.
    expect(isDegraded([{ ...base, pendingCount: 4 }])).toBe(false);
  });
});

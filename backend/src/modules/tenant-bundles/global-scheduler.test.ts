/**
 * Tests for the global tenant-bundle scheduler.
 *
 * Phase-0 (2026-05-28) live diagnosis on staging found the scheduler's
 * tenant-iteration query throws `invalid input value for enum
 * tenant_status: "deleted"` because the WHERE clause filters
 * `status != 'deleted'` but the enum only has
 * ['active','suspended','archived','pending']. Every tick fails, the
 * outer catch swallows the error, lastFiredAt stays NULL forever.
 *
 * These tests pin both:
 *  - the rendered SQL never references the invalid string 'deleted'
 *  - on a successful tick, lastFiredAt is updated even when zero
 *    tenants ran (so operators can SEE the scheduler is alive)
 */

import { describe, it, expect, vi } from 'vitest';
import { runGlobalBundleTick } from './global-scheduler.js';

interface CapturedQuery {
  text: string;
}

function renderSqlText(q: unknown): string {
  let out = '';
  const walk = (chunks: unknown[]): void => {
    for (const c of chunks) {
      if (c && typeof c === 'object' && 'queryChunks' in c) {
        walk((c as { queryChunks: unknown[] }).queryChunks);
        continue;
      }
      if (c && typeof c === 'object' && 'value' in c) {
        const v = (c as { value: unknown }).value;
        if (Array.isArray(v) && typeof v[0] === 'string') out += v[0];
        else if (typeof v === 'string') out += v;
      }
    }
  };
  if (q && typeof q === 'object' && 'queryChunks' in q) {
    walk((q as { queryChunks: unknown[] }).queryChunks);
  }
  return out;
}

function makeApp(opts: {
  schedule: { enabled: boolean; cronExpression: string | null; lastFiredAt: Date | null; retentionDays: number } | null;
  eligibleTenants: Array<{ id: string; name: string }>;
}): { app: { db: unknown; log: { info: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } }; captured: { whereClauses: string[]; updateCalls: number } } {
  const captured = { whereClauses: [] as string[], updateCalls: 0 };

  type SelectChain = {
    from: (..._args: unknown[]) => SelectChain & PromiseLike<unknown>;
    innerJoin: (..._args: unknown[]) => SelectChain & PromiseLike<unknown>;
    where: (cond: unknown) => SelectChain & PromiseLike<unknown>;
    limit: (..._args: unknown[]) => SelectChain & PromiseLike<unknown>;
    then: (resolve: (v: unknown) => void) => void;
  };

  function scheduleResult(): unknown[] {
    return opts.schedule ? [opts.schedule] : [];
  }

  // The chain is shared across .from(), .innerJoin(), .where() calls.
  // A .innerJoin() call marks this as the tenant query (the schedule
  // SELECT doesn't join). The .then() resolver returns the right shape
  // when awaited.
  type ChainState = { joined: boolean };
  const makeChain = (state: ChainState = { joined: false }): SelectChain => ({
    from: (_table: unknown) => makeChain(state) as SelectChain & PromiseLike<unknown>,
    innerJoin: (..._args: unknown[]) => {
      state.joined = true;
      return makeChain(state) as SelectChain & PromiseLike<unknown>;
    },
    where: (cond: unknown) => {
      captured.whereClauses.push(renderSqlText(cond));
      return makeChain(state) as SelectChain & PromiseLike<unknown>;
    },
    limit: () => makeChain(state) as SelectChain & PromiseLike<unknown>,
    then: (resolve: (v: unknown) => void) => {
      resolve(state.joined ? opts.eligibleTenants : scheduleResult());
    },
  });

  const updateChain = {
    set: () => updateChain,
    where: () => updateChain,
    then: (resolve: (v: unknown) => void) => {
      captured.updateCalls += 1;
      resolve(undefined);
    },
  } as { set: (..._a: unknown[]) => typeof updateChain; where: (..._a: unknown[]) => typeof updateChain; then: (r: (v: unknown) => void) => void };

  const db = {
    select: () => makeChain(),
    update: () => updateChain,
  };

  return {
    app: {
      db,
      log: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
    captured,
  };
}

describe('runGlobalBundleTick — tenant filter SQL', () => {
  it('does NOT use the invalid enum value "deleted" in the WHERE clause', async () => {
    // Cron "13 13 * * *" fires at 13:13 UTC; we drive now=13:13:30 so
    // the tick lands inside the ±5min window and the tenant query
    // actually runs.
    const { app, captured } = makeApp({
      schedule: { enabled: true, cronExpression: '13 13 * * *', lastFiredAt: null, retentionDays: 30 },
      eligibleTenants: [],
    });
    const now = new Date(Date.UTC(2026, 4, 28, 13, 13, 30));

    await runGlobalBundleTick(app as unknown as Parameters<typeof runGlobalBundleTick>[0], now);

    // The tenant-filter WHERE has both a status check and a COALESCE
    // over include_in_scheduled_bundles. Column references render as
    // bind-placeholders in our mock, so anchor on the literal SQL
    // tokens 'COALESCE' or the status string literals.
    const tenantWhereClauses = captured.whereClauses.filter(s => /COALESCE/.test(s));
    expect(tenantWhereClauses.length).toBeGreaterThanOrEqual(1);
    for (const clause of tenantWhereClauses) {
      // The bug: filter referenced 'deleted', which is not in
      // tenant_status enum ['active','suspended','archived','pending'].
      expect(clause).not.toMatch(/'deleted'/);
    }
  });

  it('uses "archived" (the actual terminal-state enum value) in the tenant filter', async () => {
    const { app, captured } = makeApp({
      schedule: { enabled: true, cronExpression: '13 13 * * *', lastFiredAt: null, retentionDays: 30 },
      eligibleTenants: [],
    });
    const now = new Date(Date.UTC(2026, 4, 28, 13, 13, 30));

    await runGlobalBundleTick(app as unknown as Parameters<typeof runGlobalBundleTick>[0], now);

    const tenantWhereClauses = captured.whereClauses.filter(s => /COALESCE/.test(s));
    expect(tenantWhereClauses.length).toBeGreaterThanOrEqual(1);
    expect(tenantWhereClauses.some(c => /'archived'/.test(c))).toBe(true);
  });

  it('marks lastFiredAt even when there are zero eligible tenants (so operators can SEE the scheduler ran)', async () => {
    const { app, captured } = makeApp({
      schedule: { enabled: true, cronExpression: '13 13 * * *', lastFiredAt: null, retentionDays: 30 },
      eligibleTenants: [],
    });
    const now = new Date(Date.UTC(2026, 4, 28, 13, 13, 30));

    const result = await runGlobalBundleTick(app as unknown as Parameters<typeof runGlobalBundleTick>[0], now);

    expect(result.fired).toBe(true);
    expect(result.tenantsConsidered).toBe(0);
    // The bug we're patching: previously when runOneScheduledBundle
    // wasn't exported, an early `return` skipped the UPDATE. That's
    // gone — every successful tick MUST stamp lastFiredAt so the
    // admin UI shows "scheduler is alive".
    expect(captured.updateCalls).toBeGreaterThanOrEqual(1);
  });

  it('returns fired=false when the cron is outside the ±5min window', async () => {
    const { app } = makeApp({
      schedule: { enabled: true, cronExpression: '13 13 * * *', lastFiredAt: null, retentionDays: 30 },
      eligibleTenants: [],
    });
    // 14:00 UTC — far outside any ±5min window of 13:13.
    const now = new Date(Date.UTC(2026, 4, 28, 14, 0, 0));

    const result = await runGlobalBundleTick(app as unknown as Parameters<typeof runGlobalBundleTick>[0], now);

    expect(result.fired).toBe(false);
  });

  it('accepts step-syntax cron expressions like "*/10 * * * *" (Phase-1.5 parser upgrade)', async () => {
    // Pre-fix: parseSimpleCron returned null for any non-literal
    // minute/hour, so `mail` (*/10 * * * *) silently never fired.
    const { app } = makeApp({
      schedule: { enabled: true, cronExpression: '*/10 * * * *', lastFiredAt: null, retentionDays: 30 },
      eligibleTenants: [],
    });
    // 13:10 UTC — a step-cron `*/10` fires every 10 min; this is on
    // a step. Pre-fix returned false (because parser said null);
    // post-fix returns true.
    const now = new Date(Date.UTC(2026, 4, 28, 13, 10, 0));

    const result = await runGlobalBundleTick(app as unknown as Parameters<typeof runGlobalBundleTick>[0], now);

    expect(result.fired).toBe(true);
  });

  it('accepts list-syntax cron expressions like "0,30 * * * *"', async () => {
    const { app } = makeApp({
      schedule: { enabled: true, cronExpression: '0,30 * * * *', lastFiredAt: null, retentionDays: 30 },
      eligibleTenants: [],
    });
    const now = new Date(Date.UTC(2026, 4, 28, 13, 30, 0));
    const result = await runGlobalBundleTick(app as unknown as Parameters<typeof runGlobalBundleTick>[0], now);
    expect(result.fired).toBe(true);
  });

  it('rejects garbage cron and does not fire (no surprise crashes)', async () => {
    const { app } = makeApp({
      schedule: { enabled: true, cronExpression: 'every banana', lastFiredAt: null, retentionDays: 30 },
      eligibleTenants: [],
    });
    const now = new Date(Date.UTC(2026, 4, 28, 13, 30, 0));
    const result = await runGlobalBundleTick(app as unknown as Parameters<typeof runGlobalBundleTick>[0], now);
    expect(result.fired).toBe(false);
  });

  it('rejects range-syntax cron "0-30 * * * *" (range support intentionally not added)', async () => {
    // Range syntax is rejected so operators get an unambiguous
    // failure rather than a silent partial-fire. Will be promoted
    // to "supported" only when a real schedule needs it.
    const { app } = makeApp({
      schedule: { enabled: true, cronExpression: '0-30 * * * *', lastFiredAt: null, retentionDays: 30 },
      eligibleTenants: [],
    });
    const now = new Date(Date.UTC(2026, 4, 28, 13, 15, 0));
    const result = await runGlobalBundleTick(app as unknown as Parameters<typeof runGlobalBundleTick>[0], now);
    expect(result.fired).toBe(false);
  });
});

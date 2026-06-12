import { describe, it, expect, vi, beforeEach } from 'vitest';

const { notifyFiringSpy, notifyResolvedSpy } = vi.hoisted(() => ({
  notifyFiringSpy: vi.fn().mockResolvedValue(undefined),
  notifyResolvedSpy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../notifications/events.js', () => ({
  notifyAdminSloAlertFiring: notifyFiringSpy,
  notifyAdminSloAlertResolved: notifyResolvedSpy,
}));

import { evaluateOnce, __resetEvaluatorStateForTest, VM_FAILURE_THRESHOLD } from './evaluator.js';
import { SLO_RULES, MONITORING_UNREACHABLE_RULE_ID, renderExpr, ruleById } from './rules.js';

const logger = { info: vi.fn(), warn: vi.fn() };

/**
 * In-memory stub of the two tables the evaluator touches. Mimics the
 * narrow drizzle surface used: select().from(t)[.where(...)],
 * insert(t).values(v), update(t).set(v).where(...).
 */
function dbStub(initial: { overrides?: Array<Record<string, unknown>> } = {}) {
  const alertRows = new Map<string, Record<string, unknown>>();
  const overrides = initial.overrides ?? [];
  const isAlertTable = (t: unknown): boolean =>
    Boolean(t && typeof t === 'object' && 'ruleId' in (t as object) && 'lastNotifiedAt' in (t as object));
  let pendingWhereRule: string | null = null;
  const db = {
    select: () => ({
      from: (t: unknown) => {
        const rows = isAlertTable(t) ? [...alertRows.values()] : overrides;
        const arr = Object.assign(Promise.resolve(rows), {
          where: (cond: unknown) => {
            // eq(alertState.ruleId, X) — extract the literal the same way
            // drizzle stores it (queryChunks Param). Fallback: full scan.
            const chunks = (cond as { queryChunks?: Array<{ value?: unknown; constructor: { name: string } }> })?.queryChunks ?? [];
            const param = chunks.find((c) => c?.constructor?.name === 'Param');
            const id = typeof param?.value === 'string' ? param.value : null;
            return Promise.resolve(id ? [...alertRows.values()].filter((r) => r.ruleId === id) : [...alertRows.values()]);
          },
        });
        return arr;
      },
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        alertRows.set(String(v.ruleId), { ...v });
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          const chunks = (cond as { queryChunks?: Array<{ value?: unknown; constructor: { name: string } }> })?.queryChunks ?? [];
          const param = chunks.find((c) => c?.constructor?.name === 'Param');
          const id = typeof param?.value === 'string' ? param.value : pendingWhereRule;
          if (id && alertRows.has(id)) alertRows.set(id, { ...alertRows.get(id)!, ...v });
          return Promise.resolve();
        },
      }),
    }),
    _rows: alertRows,
  };
  return db;
}

/** fetch stub: map of "matched expr substring" → samples (or 'fail'). */
function vmFetchStub(behavior: Record<string, number[] | 'fail'>) {
  return vi.fn(async (url: string | URL) => {
    const u = decodeURIComponent(String(url));
    for (const [needle, conf] of Object.entries(behavior)) {
      if (!u.includes(needle)) continue;
      if (conf === 'fail') return { ok: false, status: 503, json: async () => ({}) } as Response;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'success',
          data: { resultType: 'vector', result: conf.map((v) => ({ metric: {}, value: [1, String(v)] })) },
        }),
      } as unknown as Response;
    }
    // default: healthy (empty vector)
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'success', data: { resultType: 'vector', result: [] } }),
    } as unknown as Response;
  });
}

beforeEach(() => {
  __resetEvaluatorStateForTest();
  notifyFiringSpy.mockClear();
  notifyResolvedSpy.mockClear();
});

describe('monitoring rules pack', () => {
  it('every rule has a unique id and renders $T', () => {
    const ids = new Set(SLO_RULES.map((r) => r.id));
    expect(ids.size).toBe(SLO_RULES.length);
    for (const r of SLO_RULES) {
      expect(r.expr).toContain('$T');
      expect(renderExpr(r, null)).not.toContain('$T');
      expect(renderExpr(r, 0.42)).toContain('0.42');
    }
  });

  it('the LE canary rule exists with a zero-tolerance posture', () => {
    const r = ruleById('acme-order-rate');
    expect(r).toBeDefined();
    expect(r!.expr).toContain('platform_acme_renewals_total');
  });
});

describe('monitoring evaluator', () => {
  it('fires immediately for forSeconds=0 rules and notifies admins once', async () => {
    const db = dbStub();
    // Violate only the acme-order-rate rule (forSeconds=0).
    const fetchFn = vmFetchStub({ platform_acme_renewals_total: [7] });
    await evaluateOnce(db as never, logger, { fetchFn, baseUrl: 'http://vm' });
    const row = db._rows.get('acme-order-rate');
    expect(row?.state).toBe('firing');
    expect(notifyFiringSpy).toHaveBeenCalledTimes(1);
    expect(notifyFiringSpy.mock.calls[0][1]).toMatchObject({
      ruleId: 'acme-order-rate',
      severity: 'warning',
      value: '7',
    });
    expect(notifyFiringSpy.mock.calls[0][1].ruleName).toContain('ACME renewal activity');

    // Second tick, still violated → throttled (no second notification).
    await evaluateOnce(db as never, logger, { fetchFn, baseUrl: 'http://vm' });
    expect(notifyFiringSpy).toHaveBeenCalledTimes(1);
  });

  it('holds for forSeconds before firing, then resolves with a notification', async () => {
    const db = dbStub();
    const fetchFn = vmFetchStub({ cnpg: [1] }); // cnpg-down: forSeconds=300
    const t0 = new Date('2026-06-12T10:00:00Z');
    await evaluateOnce(db as never, logger, { fetchFn, baseUrl: 'http://vm' }, t0);
    expect(db._rows.get('cnpg-down')?.state ?? 'absent').not.toBe('firing'); // pending

    const t1 = new Date(t0.getTime() + 6 * 60_000);
    await evaluateOnce(db as never, logger, { fetchFn, baseUrl: 'http://vm' }, t1);
    expect(db._rows.get('cnpg-down')?.state).toBe('firing');
    expect(notifyFiringSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(notifyFiringSpy.mock.calls.at(-1)![1]).toMatchObject({
      ruleId: 'cnpg-down',
      severity: 'critical',
    });

    // Recovery → resolved + resolved-category notification.
    const healthy = vmFetchStub({});
    const t2 = new Date(t1.getTime() + 60_000);
    await evaluateOnce(db as never, logger, { fetchFn: healthy, baseUrl: 'http://vm' }, t2);
    expect(db._rows.get('cnpg-down')?.state).toBe('resolved');
    expect(notifyResolvedSpy).toHaveBeenCalledTimes(1);
    expect(notifyResolvedSpy.mock.calls[0][1]).toMatchObject({ ruleId: 'cnpg-down' });
  });

  it('fires on ZERO-VALUED comparison passes (vector(0) > -1 shape)', async () => {
    // Regression for the live 2026-06-12 induce: `(count(...) or
    // vector(0)) > -1` passes with sample value 0 — the evaluator must
    // treat ANY surviving sample as a violation, not just value>0.
    const db = dbStub({ overrides: [{ ruleId: 'acme-order-rate', enabled: true, threshold: -1 }] });
    const fetchFn = vmFetchStub({ platform_acme_renewals_total: [0] });
    await evaluateOnce(db as never, logger, { fetchFn, baseUrl: 'http://vm' });
    expect(db._rows.get('acme-order-rate')?.state).toBe('firing');
  });

  it('disabled override suppresses evaluation', async () => {
    const db = dbStub({ overrides: [{ ruleId: 'acme-order-rate', enabled: false, threshold: null }] });
    const fetchFn = vmFetchStub({ platform_acme_renewals_total: [99] });
    await evaluateOnce(db as never, logger, { fetchFn, baseUrl: 'http://vm' });
    expect(db._rows.has('acme-order-rate')).toBe(false);
    expect(notifyFiringSpy).not.toHaveBeenCalled();
  });

  it('threshold override re-parameterises the expression', async () => {
    const db = dbStub({ overrides: [{ ruleId: 'longhorn-headroom', enabled: true, threshold: 0.01 }] });
    const fetchFn = vmFetchStub({});
    await evaluateOnce(db as never, logger, { fetchFn, baseUrl: 'http://vm' });
    const urls = fetchFn.mock.calls.map((c) => decodeURIComponent(String(c[0])));
    const lh = urls.find((u) => u.includes('longhorn_node_storage_usage_bytes'));
    expect(lh).toContain('> 0.01');
  });

  it('raises monitoring-unreachable after consecutive total failures, via the VM-independent path', async () => {
    const db = dbStub();
    const failAll = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) } as Response));
    for (let i = 0; i < VM_FAILURE_THRESHOLD; i += 1) {
      await evaluateOnce(db as never, logger, { fetchFn: failAll as never, baseUrl: 'http://vm' });
    }
    const row = db._rows.get(MONITORING_UNREACHABLE_RULE_ID);
    expect(row?.state).toBe('firing');
    expect(notifyFiringSpy.mock.calls.some(
      (c) => c[1].ruleId === MONITORING_UNREACHABLE_RULE_ID && c[1].severity === 'critical',
    )).toBe(true);

    // One healthy tick clears the streak and resolves.
    const healthy = vmFetchStub({});
    await evaluateOnce(db as never, logger, { fetchFn: healthy, baseUrl: 'http://vm' });
    expect(db._rows.get(MONITORING_UNREACHABLE_RULE_ID)?.state).toBe('resolved');
  });
});

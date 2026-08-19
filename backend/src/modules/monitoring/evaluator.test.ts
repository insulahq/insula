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

  // alert_state is keyed by (rule_id, subject_key) now, so the stub is too.
  const rowKey = (ruleId: unknown, subjectKey: unknown): string =>
    `${String(ruleId)}\u0000${String(subjectKey ?? '')}`;

  /**
   * Collect every literal in a drizzle condition, walking NESTED
   * queryChunks. `and(eq(a, x), eq(b, y))` nests its Params one level down;
   * a flat `chunks.find(Param)` sees none of them, silently matched
   * nothing, and made every update a no-op.
   */
  const paramsOf = (cond: unknown): string[] => {
    const out: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as { value?: unknown; queryChunks?: unknown[]; constructor?: { name?: string } };
      if (n.constructor?.name === 'Param' && typeof n.value === 'string') out.push(n.value);
      for (const child of n.queryChunks ?? []) walk(child);
    };
    walk(cond);
    return out;
  };

  const matches = (row: Record<string, unknown>, params: string[]): boolean => {
    if (params.length === 0) return true;
    const [ruleId, subjectKey] = params;
    if (row.ruleId !== ruleId) return false;
    // A rule-scoped query (one param) matches every subject of that rule.
    return params.length < 2 || String(row.subjectKey ?? '') === subjectKey;
  };

  const db = {
    select: () => ({
      from: (t: unknown) => {
        const rows = isAlertTable(t) ? [...alertRows.values()] : overrides;
        return Object.assign(Promise.resolve(rows), {
          where: (cond: unknown) => Promise.resolve(
            [...alertRows.values()].filter((r) => matches(r, paramsOf(cond))),
          ),
        });
      },
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        alertRows.set(rowKey(v.ruleId, v.subjectKey), { ...v });
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          const params = paramsOf(cond);
          for (const [k, row] of alertRows) {
            if (matches(row, params)) alertRows.set(k, { ...row, ...v });
          }
          return Promise.resolve();
        },
      }),
    }),
    _rows: alertRows,
    /** Tests address rows by rule id; every rule here has one subject. */
    _row: (ruleId: string): Record<string, unknown> | undefined =>
      [...alertRows.values()].find((r) => r.ruleId === ruleId),
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
    const row = db._row('acme-order-rate');
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
    // Match the cnpg-down expr by its job selector — a bare 'cnpg' substring
    // would also hit the system-container-oom rule's cnpg-system namespace.
    const fetchFn = vmFetchStub({ 'job="cnpg"': [1] }); // cnpg-down: forSeconds=300
    const t0 = new Date('2026-06-12T10:00:00Z');
    await evaluateOnce(db as never, logger, { fetchFn, baseUrl: 'http://vm' }, t0);
    expect(db._row('cnpg-down')?.state ?? 'absent').not.toBe('firing'); // pending

    const t1 = new Date(t0.getTime() + 6 * 60_000);
    await evaluateOnce(db as never, logger, { fetchFn, baseUrl: 'http://vm' }, t1);
    expect(db._row('cnpg-down')?.state).toBe('firing');
    expect(notifyFiringSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(notifyFiringSpy.mock.calls.at(-1)![1]).toMatchObject({
      ruleId: 'cnpg-down',
      severity: 'critical',
    });

    // Recovery → resolved + resolved-category notification.
    const healthy = vmFetchStub({});
    const t2 = new Date(t1.getTime() + 60_000);
    await evaluateOnce(db as never, logger, { fetchFn: healthy, baseUrl: 'http://vm' }, t2);
    expect(db._row('cnpg-down')?.state).toBe('resolved');
    expect(notifyResolvedSpy).toHaveBeenCalledTimes(1);
    expect(notifyResolvedSpy.mock.calls[0][1]).toMatchObject({ ruleId: 'cnpg-down' });
  });

  it('tracks and NAMES each affected object separately', async () => {
    // The operator's report: "CERT NOT READY and CERT EXPIRY in
    // notifications, the SLO page and Active Alerts, but NOWHERE does it
    // show which certificate and which tenant is affected."
    //
    // Two broken certificates in different namespaces must produce two
    // alert rows and two notifications, each naming its own certificate.
    const db = dbStub();
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = decodeURIComponent(String(url));
      const hit = u.includes('certmanager_certificate_ready_status');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'success',
          data: {
            resultType: 'vector',
            result: hit
              ? [
                  { metric: { name: 'wildcard-tls', namespace: 'tenant-acme', condition: 'False' }, value: [1, '1'] },
                  { metric: { name: 'apex-tls', namespace: 'platform', condition: 'False' }, value: [1, '1'] },
                ]
              : [],
          },
        }),
      } as unknown as Response;
    });

    const t0 = new Date('2026-08-19T10:00:00Z');
    await evaluateOnce(db as never, logger, { fetchFn: fetchFn as never, baseUrl: 'http://vm' }, t0);
    // cert-not-ready has forSeconds=1800 — hold past it.
    const t1 = new Date(t0.getTime() + 31 * 60_000);
    await evaluateOnce(db as never, logger, { fetchFn: fetchFn as never, baseUrl: 'http://vm' }, t1);

    const rows = [...db._rows.values()].filter((r) => r.ruleId === 'cert-not-ready');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.state === 'firing')).toBe(true);

    const subjects = rows.map((r) => (r.subjectLabels as Record<string, string>).name).sort();
    expect(subjects).toEqual(['apex-tls', 'wildcard-tls']);

    // …and the admin is TOLD which one, not just that "a certificate" broke.
    const certCalls = notifyFiringSpy.mock.calls.filter((c) => c[1].ruleId === 'cert-not-ready');
    expect(certCalls).toHaveLength(2);
    const labels = certCalls.map((c) => c[1].subject).sort();
    expect(labels[0]).toContain('apex-tls');
    expect(labels[0]).toContain('platform');
    expect(labels[1]).toContain('wildcard-tls');
    expect(labels[1]).toContain('tenant-acme');
  });

  it('resolves one object while the other stays firing', async () => {
    const db = dbStub();
    const respond = (certs: Array<Record<string, string>>) => vi.fn(async (url: string | URL) => {
      const hit = decodeURIComponent(String(url)).includes('certmanager_certificate_ready_status');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'success',
          data: {
            resultType: 'vector',
            result: hit ? certs.map((m) => ({ metric: m, value: [1, '1'] })) : [],
          },
        }),
      } as unknown as Response;
    });

    const both = respond([
      { name: 'wildcard-tls', namespace: 'tenant-acme', condition: 'False' },
      { name: 'apex-tls', namespace: 'platform', condition: 'False' },
    ]);
    const t0 = new Date('2026-08-19T10:00:00Z');
    await evaluateOnce(db as never, logger, { fetchFn: both as never, baseUrl: 'http://vm' }, t0);
    const t1 = new Date(t0.getTime() + 31 * 60_000);
    await evaluateOnce(db as never, logger, { fetchFn: both as never, baseUrl: 'http://vm' }, t1);

    // apex-tls recovers; wildcard-tls is still broken.
    const oneLeft = respond([{ name: 'wildcard-tls', namespace: 'tenant-acme', condition: 'False' }]);
    const t2 = new Date(t1.getTime() + 60_000);
    await evaluateOnce(db as never, logger, { fetchFn: oneLeft as never, baseUrl: 'http://vm' }, t2);

    const byName = new Map(
      [...db._rows.values()]
        .filter((r) => r.ruleId === 'cert-not-ready')
        .map((r) => [(r.subjectLabels as Record<string, string>).name, r.state]),
    );
    expect(byName.get('apex-tls')).toBe('resolved');
    expect(byName.get('wildcard-tls')).toBe('firing');

    const resolvedFor = notifyResolvedSpy.mock.calls.filter((c) => c[1].ruleId === 'cert-not-ready');
    expect(resolvedFor).toHaveLength(1);
    expect(resolvedFor[0][1].subject).toContain('apex-tls');
  });

  it('fires on ZERO-VALUED comparison passes (vector(0) > -1 shape)', async () => {
    // Regression for the live 2026-06-12 induce: `(count(...) or
    // vector(0)) > -1` passes with sample value 0 — the evaluator must
    // treat ANY surviving sample as a violation, not just value>0.
    const db = dbStub({ overrides: [{ ruleId: 'acme-order-rate', enabled: true, threshold: -1 }] });
    const fetchFn = vmFetchStub({ platform_acme_renewals_total: [0] });
    await evaluateOnce(db as never, logger, { fetchFn, baseUrl: 'http://vm' });
    expect(db._row('acme-order-rate')?.state).toBe('firing');
  });

  it('disabled override suppresses evaluation', async () => {
    const db = dbStub({ overrides: [{ ruleId: 'acme-order-rate', enabled: false, threshold: null }] });
    const fetchFn = vmFetchStub({ platform_acme_renewals_total: [99] });
    await evaluateOnce(db as never, logger, { fetchFn, baseUrl: 'http://vm' });
    expect((db._row('acme-order-rate') !== undefined)).toBe(false);
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
    const row = db._row(MONITORING_UNREACHABLE_RULE_ID);
    expect(row?.state).toBe('firing');
    expect(notifyFiringSpy.mock.calls.some(
      (c) => c[1].ruleId === MONITORING_UNREACHABLE_RULE_ID && c[1].severity === 'critical',
    )).toBe(true);

    // One healthy tick clears the streak and resolves.
    const healthy = vmFetchStub({});
    await evaluateOnce(db as never, logger, { fetchFn: healthy, baseUrl: 'http://vm' });
    expect(db._row(MONITORING_UNREACHABLE_RULE_ID)?.state).toBe('resolved');
  });
});

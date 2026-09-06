/**
 * Regression tests for the auto-ban watermark.
 *
 * The scheduler used to advance a watermark holding a bare `waf_logs.id`
 * and fetch the next batch with `WHERE id > <watermark> ORDER BY id ASC`.
 * `waf_logs.id` is a random UUID v4, so that ordered by noise. The very
 * first tick seeded the watermark via `ORDER BY id DESC LIMIT 1` — the
 * largest random UUID in the table, which sits near the top of the UUID
 * space — and every later tick then found nothing, because almost no new
 * random UUID sorts above it.
 *
 * Observed on production 2026-09-05: watermark `ffd20474…` (~99.93rd
 * percentile of the UUID space), 502 rows in `waf_logs`, **0** of them
 * visible to the scheduler, **0** rows ever written to
 * `crowdsec_autoban_runs` — while a scanner with 18 qualifying events
 * against a threshold of 5 was never banned.
 *
 * These assert the emitted SQL rather than a behaviour that happens to
 * work on a lucky set of UUIDs: the defect is in the ordering contract,
 * and any test whose fixtures sort the same way by id and by time would
 * pass against the broken code.
 */

import { describe, it, expect, vi } from 'vitest';
import { parseWatermark, formatWatermark, runOnce } from './scheduler.js';

/**
 * Rows deliberately built so UUID order DISAGREES with time order, listed
 * in the order `ORDER BY created_at ASC` returns them: oldest first. The
 * NEWEST row carries the SMALLEST uuid, so any code that treats the id as
 * a position picks the wrong row.
 */
const ROWS = [
  // older event whose UUID sorts near the TOP of the space
  {
    id: 'ffd20474-3244-4654-b048-59ceb80ae147',
    created_at: new Date('2026-09-02T18:28:01Z'),
    created_at_text: '2026-09-02 18:28:01.000000',
    source_ip: '198.51.100.9',
    hostname: 'admin.example.test',
    rule_id: '930120',
    severity: 'critical',
    tenant_id: null,
  },
  // newest event, but its UUID sorts near the BOTTOM
  {
    id: '00000000-0000-4000-8000-000000000001',
    created_at: new Date('2026-09-05T05:51:59Z'),
    created_at_text: '2026-09-05 05:51:59.123456',
    source_ip: '44.220.172.166',
    hostname: 'admin.example.test',
    rule_id: '934100',
    severity: 'critical',
    tenant_id: null,
  },
];

/** Split a Drizzle sql`` template into its static text and its bound params. */
function dissect(query: unknown): { text: string; params: unknown[] } {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  const text: string[] = [];
  const params: unknown[] = [];
  for (const c of chunks) {
    // Drizzle wraps literal SQL in a StringChunk ({value: string[]}) and
    // may wrap a bound value in a Param ({value: scalar}) — but a plain
    // JS primitive is pushed onto queryChunks as-is, with no wrapper.
    if (c !== null && typeof c === 'object' && 'value' in c) {
      const v = (c as { value: unknown }).value;
      if (Array.isArray(v)) text.push(v.join(' '));
      else params.push(v);
      continue;
    }
    params.push(c);
  }
  return { text: text.join(' '), params };
}

function makeDeps(rows: typeof ROWS) {
  const executed: Array<{ text: string; params: unknown[] }> = [];
  // loadSettings / pastBansPerIp go through the typed query builder.
  const builder = {
    select: () => builder,
    from: () => builder,
    where: () => builder,
    groupBy: () => [],
    then: (r: (v: unknown[]) => unknown) => r([]),
  };
  const db = {
    select: () => builder,
    insert: () => ({ values: async () => undefined }),
    execute: vi.fn(async (q: unknown) => {
      const d = dissect(q);
      executed.push(d);
      if (/FROM waf_logs/i.test(d.text)) return { rows };
      return { rows: [] };
    }),
  };
  return {
    deps: { db, kubeconfigPath: undefined, log: { info: vi.fn(), warn: vi.fn() } },
    executed,
  };
}

describe('watermark serialisation', () => {
  it('round-trips a (createdAt, id) cursor', () => {
    const c = { createdAt: '2026-09-05 05:51:59.000000', id: 'abc-123' };
    expect(parseWatermark(formatWatermark(c))).toEqual(c);
  });

  it('PRESERVES MICROSECONDS through the round trip', () => {
    // The production bug: the cursor went through a JS Date, which has only
    // millisecond resolution, so `.188583` was stored as `.188`. The row's own
    // timestamp then compared GREATER than its own watermark and the boundary
    // row was re-read on every tick, forever — the watermark never advanced.
    const c = { createdAt: '2026-09-06 19:18:07.188583', id: '16e16d2f-19c2-45d0-8179-332fc4664df5' };
    const round = parseWatermark(formatWatermark(c));
    expect(round?.createdAt).toBe('2026-09-06 19:18:07.188583');
    expect(round?.createdAt).not.toBe('2026-09-06 19:18:07.188');
  });

  it('still reads a legacy ISO watermark written by the previous version', () => {
    const round = parseWatermark('2026-09-06T19:18:07.188Z|16e16d2f');
    expect(round?.id).toBe('16e16d2f');
    expect(round?.createdAt).toBe('2026-09-06T19:18:07.188Z');
  });

  it('treats a legacy bare-UUID watermark as NO cursor', () => {
    // The literal production value. It must not be read as a position:
    // it was chosen by random-UUID order and means nothing in time.
    expect(parseWatermark('ffd20474-3244-4654-b048-59ceb80ae147')).toBeNull();
  });

  it('rejects a malformed cursor rather than yielding an Invalid Date', () => {
    expect(parseWatermark('not-a-date|abc')).toBeNull();
    expect(parseWatermark('2026-09-05T05:51:59.000Z|')).toBeNull();
    expect(parseWatermark(null)).toBeNull();
  });
});

describe('batch query', () => {
  const wafQuery = (executed: Array<{ text: string; params: unknown[] }>) =>
    executed.find((e) => /FROM waf_logs/i.test(e.text));

  it('never orders or filters the batch by the random id column', async () => {
    const { deps, executed } = makeDeps(ROWS);
    await runOnce(deps as never);
    const q = wafQuery(executed);
    expect(q, 'no waf_logs query was emitted').toBeTruthy();
    // The two shapes that starved the scheduler.
    expect(q!.text).not.toMatch(/ORDER BY\s+id\s+(ASC|DESC)/i);
    expect(q!.text).not.toMatch(/WHERE\s+id\s+>/i);
    expect(q!.text).toMatch(/ORDER BY created_at ASC/i);
  });

  it('with no usable cursor, scans a bounded recent window — not just the newest row', async () => {
    const { deps, executed } = makeDeps(ROWS);
    await runOnce(deps as never);
    const q = wafQuery(executed);
    // `ORDER BY id DESC LIMIT 1` is what made a burst already in flight
    // invisible on the very first tick.
    expect(q!.text).toMatch(/created_at > NOW\(\)/i);
  });

  it('advances the watermark to the newest row by TIME, whose id is the smallest here', async () => {
    const { deps, executed } = makeDeps(ROWS);
    await runOnce(deps as never);
    const save = executed.find((e) => /INSERT INTO platform_settings/i.test(e.text));
    expect(save, 'watermark was never saved').toBeTruthy();
    const cursor = save!.params.find((p) => typeof p === 'string' && p.includes('|')) as string;
    expect(cursor).toBeTruthy();
    // Rows arrive ordered by created_at, so the last is the 2026-09-05
    // event — even though its UUID sorts below the other row's.
    // The cursor carries the EXACT Postgres text form, microseconds intact —
    // not a JS Date, whose millisecond resolution truncated `.188583` to
    // `.188` and made the boundary row re-select itself forever.
    expect(parseWatermark(cursor)).toEqual({
      createdAt: '2026-09-05 05:51:59.123456',
      id: '00000000-0000-4000-8000-000000000001',
    });
  });
});

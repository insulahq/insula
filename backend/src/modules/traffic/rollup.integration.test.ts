import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { TrafficFrame } from '@insula/api-contracts';
import { getTestDb, runMigrations, isDbAvailable } from '../../test-helpers/db.js';
import { recordHourlyUsage, reapUsageMetrics } from '../metrics/usage-rollup.js';

/**
 * Every traffic graph past metric retention, through the real tables.
 *
 * The collector runs on a scripted frame source (the metrics store is the only
 * thing faked), writes to Postgres, the real reaper folds it, and the real
 * frame service draws it back — for each view the panels offer. The clock is
 * years ahead so nothing written at the real time lands in these buckets.
 */

vi.mock('../monitoring/vm-client.js', () => ({
  queryRange: () => Promise.resolve([]),
  queryInstant: () => Promise.resolve([]),
}));

const { fetchTrafficFrame } = await import('./service.js');
const { collectSpan, collectTrafficRollup } = await import('./rollup-collect.js');
const { UnsupportedTrafficQuery } = await import('./promql.js');
const { MONTH_STEP_SECONDS } = await import('./rollup-period.js');

const db = getTestDb();
const dbAvailable = await isDbAvailable();
const d = dbAvailable ? describe : describe.skip;

const DAY = 86_400_000;
const D0 = Date.parse('2031-03-10T00:00:00Z');
const D1 = D0 + DAY;
const LATER = new Date(D0 + 90 * DAY);
const A = { id: 'trf-a-0000-0000-0000-000000000001', ns: 'tenant-a-fixture', name: 'Alpha' };
const KID = { id: 'trf-k-0000-0000-0000-000000000002', ns: 'tenant-a-fixture-kid', name: 'Kid' };
const POD = 'website-6b8c9d7f4-ab12c';

type Req = Parameters<typeof fetchTrafficFrame>[0];

/** What the metrics store would answer: constant rates, quieter on the second day. */
function scripted(req: Req): TrafficFrame {
  const step = 300;
  const fromMs = req.from.getTime();
  const times: number[] = [];
  for (let t = Math.ceil(fromMs / (step * 1000)) * step * 1000; t <= req.to.getTime(); t += step * 1000) times.push(t);
  const day1 = fromMs >= D1;
  const dir = req.direction === 'in' ? 'in' : 'out';
  type Row = { key: string; name: string; kind: TrafficFrame['series'][number]['kind']; group?: TrafficFrame['series'][number]['group']; rate: number };
  let rows: Row[] = [];
  const k = `${req.scope}/${req.metric}`;
  if (k === 'cluster/traffic') {
    rows = dir === 'out'
      ? [{ key: 'wire:internet:out', name: 'Internet · outbound', kind: 'direction', group: 'wire', rate: 1000 },
        { key: 'wire:n2n', name: 'Node-to-node', kind: 'direction', group: 'wire', rate: 500 }]
      : [{ key: 'wire:internet:in', name: 'Internet · inbound', kind: 'direction', group: 'wire', rate: 200 }];
  } else if (k === 'cluster/requests') {
    rows = [{ key: 'out', name: 'out', kind: 'direction', rate: 10 }];
  } else if (k === 'cluster/latency') {
    rows = [{ key: 'out', name: 'out', kind: 'direction', rate: 50 }];
  } else if (k === 'node/traffic') {
    rows = [{ key: `${dir}:n1`, name: 'Node one', kind: 'subject', rate: day1 ? 0 : (dir === 'out' ? 300 : 100) }];
  } else if (k === 'node/requests' || k === 'node/latency') {
    throw new UnsupportedTrafficQuery('no node label on this cluster');
  } else if (k === 'tenant/traffic') {
    rows = [{ key: `${dir}:${A.ns}`, name: A.name, kind: 'subject', rate: 100 }];
  } else if (k === 'tenant/requests') {
    rows = [{ key: `out:${A.ns}`, name: A.name, kind: 'subject', rate: day1 ? 1 : 4 }];
  } else if (k === 'tenant/latency') {
    rows = [{ key: `out:${A.ns}`, name: A.name, kind: 'subject', rate: day1 ? 90 : 30 }];
  } else if (k === 'route/traffic') {
    // Named as the operator's view names them: route, then whose it is.
    rows = [
      { key: `${dir}:${A.ns}-site`, name: `site.example.test · ${A.name}`, kind: 'subject', rate: 50 },
      { key: `${dir}:${KID.ns}-web`, name: `kid.example.test · ${KID.name}`, kind: 'subject', rate: 20 },
    ];
  } else if (k === 'route/requests') {
    throw new UnsupportedTrafficQuery('no request counts on this cluster');
  } else if (k === 'route/latency') {
    rows = [{ key: `out:${A.ns}-site`, name: `site.example.test · ${A.name}`, kind: 'subject', rate: 25 }];
  } else if (k === 'pod/traffic' && req.subject === A.ns) {
    if (failPods) throw new Error('vmsingle: query timed out');
    // The live frame folds replicas per application and keys the row by its name.
    rows = [{ key: 'website', name: 'website', kind: 'subject', rate: 40 }];
  }
  return {
    from: req.from.toISOString(), to: req.to.toISOString(), stepSeconds: step,
    times: times.map((t) => new Date(t).toISOString()),
    unit: req.metric === 'requests' ? 'requests' : req.metric === 'latency' ? 'milliseconds' : 'bytes',
    resolution: 'fine', othersFolded: 0, clamped: false,
    series: rows.map(({ rate, ...r }) => ({ ...r, points: times.map(() => rate) })),
  };
}

let failPods = false;
const fetchFrame = async (req: Req) => scripted(req);

function ask(over: Partial<Req>, from = D0 - DAY, to = D0 + 3 * DAY): Req {
  return { from: new Date(from), to: new Date(to), scope: 'cluster', metric: 'traffic', direction: 'both', backups: 'separate', ...over };
}
const frameAt = (req: Req, now = LATER) => fetchTrafficFrame(req, { db, now: () => now });
const at = (f: TrafficFrame, key: string, day: number) => f.series.find((s) => s.key === key)?.points[f.times.indexOf(new Date(day).toISOString())];

async function seedTenants(): Promise<void> {
  await db.execute(sql`INSERT INTO regions (id, code, name, provider, status, created_at) VALUES ('region-trf', 'trf', 'Trf', 'hetzner', 'active', NOW()) ON CONFLICT (id) DO NOTHING`);
  await db.execute(sql`INSERT INTO hosting_plans (id, code, name, cpu_limit, memory_limit, storage_limit, monthly_price_usd, max_sub_users, status, created_at) VALUES ('plan-trf', 'trf', 'Trf', 1, 1, 1, 0, 1, 'active', NOW()) ON CONFLICT (id) DO NOTHING`);
  for (const t of [A, KID]) {
    await db.execute(sql`
      INSERT INTO tenants (id, region_id, name, primary_email, status, kubernetes_namespace, plan_id, created_at, updated_at)
      VALUES (${t.id}, 'region-trf', ${t.name}, 'trf@example.test', 'active', ${t.ns}, 'plan-trf', '2031-01-01'::timestamp, NOW())
      ON CONFLICT (id) DO NOTHING`);
  }
}

async function dropFixtures(): Promise<void> {
  await db.execute(sql`DELETE FROM traffic_rollup_series`);
  await db.execute(sql`DELETE FROM traffic_rollup_coverage`);
  await db.execute(sql`DELETE FROM platform_settings WHERE setting_key = 'traffic_rollup_through'`);
  await db.execute(sql`DELETE FROM tenants WHERE id IN (${A.id}, ${KID.id})`);
  await db.execute(sql`DELETE FROM hosting_plans WHERE id = 'plan-trf'`);
  await db.execute(sql`DELETE FROM regions WHERE id = 'region-trf'`);
}

d('the traffic rollup, every view', () => {
  beforeAll(async () => {
    await runMigrations();
    await dropFixtures();
    await seedTenants();
    await collectSpan({ db, fetchFrame }, D0, D1);
    await collectSpan({ db, fetchFrame }, D1, D1 + DAY);
  });
  afterAll(dropFixtures);

  it('cluster: every row in its usual order, a day of bytes ÷ a day', async () => {
    const f = await frameAt(ask({}));
    expect(f.resolution).toBe('daily');
    expect(f.clamped).toBe(false);
    expect(f.series.map((s) => s.key)).toEqual(['wire:internet:out', 'wire:internet:in', 'wire:n2n']);
    expect(f.series[0].group).toBe('wire');
    expect(at(f, 'wire:internet:out', D0)).toBeCloseTo(1000);
    expect(at(f, 'wire:internet:in', D1)).toBeCloseTo(200);
  });

  it('a day nobody measured is a gap, a measured day without traffic is zero', async () => {
    const f = await frameAt(ask({ scope: 'node', subject: 'n1', backups: 'included' }));
    expect(f.series.map((s) => [s.key, s.name])).toEqual([['out', 'Outbound'], ['in', 'Inbound']]);
    expect(at(f, 'out', D0)).toBeCloseTo(300);
    expect(at(f, 'in', D0)).toBeCloseTo(100);
    expect(at(f, 'out', D1)).toBe(0);
    expect(at(f, 'out', D1 + DAY)).toBeNull();
  });

  it('a breakdown names one row per subject in the asked direction', async () => {
    const f = await frameAt(ask({ scope: 'node', direction: 'out', backups: 'included' }));
    expect(f.series.map((s) => [s.key, s.name])).toEqual([['out:n1', 'Node one']]);
  });

  it('a view the store never had (requests per node) is drawn empty, not as an error', async () => {
    const f = await frameAt(ask({ scope: 'node', metric: 'requests', backups: 'included' }));
    expect(f.series).toEqual([]);
  });

  it('latency is weighted by the requests behind it, across the day boundary too', async () => {
    const f = await frameAt(ask({ scope: 'tenant', subject: A.ns, metric: 'latency', backups: 'included' }));
    expect(at(f, 'out', D0)).toBeCloseTo(30);
    expect(at(f, 'out', D1)).toBeCloseTo(90);
    const req = await frameAt(ask({ scope: 'tenant', subject: A.ns, metric: 'requests', backups: 'included' }));
    expect(at(req, 'out', D0)).toBeCloseTo(4);
  });

  it("a tenant's own routes leave out a nested tenant's, though its namespace starts the same", async () => {
    const f = await frameAt(ask({ scope: 'route', direction: 'out', backups: 'included', restrictToNamespace: A.ns }));
    // …and names them as the tenant's own panel does, without saying whose they are.
    expect(f.series.map((s) => s.name)).toEqual(['site.example.test']);
    const admin = await frameAt(ask({ scope: 'route', direction: 'out', backups: 'included' }));
    expect(admin.series.map((s) => s.name).sort()).toEqual([`kid.example.test · ${KID.name}`, `site.example.test · ${A.name}`]);
  });

  it("a tenant asking for another tenant's route by name gets nothing of it", async () => {
    const f = await frameAt(ask({
      scope: 'route', subject: `${KID.ns}-web`, direction: 'both', backups: 'included', restrictToNamespace: A.ns,
    }));
    expect(f.series.flatMap((s) => s.points).some((v) => (v ?? 0) > 0)).toBe(false);
    const admin = await frameAt(ask({ scope: 'route', subject: `${KID.ns}-web`, direction: 'both', backups: 'included' }));
    expect(at(admin, 'out', D0)).toBeCloseTo(20);
  });

  it('pods: per application within the tenant, keyed as the live frame keys them', async () => {
    const f = await frameAt(ask({ scope: 'pod', subject: A.ns, direction: 'both', backups: 'included' }));
    expect(f.series.map((s) => [s.key, s.name])).toEqual([['website · out', 'website · out'], ['website · in', 'website · in']]);
    // The panel sends a row's key back as `pod`; a replica's own name works too.
    for (const pod of ['website', POD]) {
      const one = await frameAt(ask({ scope: 'pod', subject: A.ns, pod, direction: 'both', backups: 'included' }));
      expect(at(one, 'out', D0)).toBeCloseTo(40);
    }
  });

  it('a 30-day range is still the live store, not the rollup', async () => {
    const f = await frameAt(ask({ scope: 'node', subject: 'n1', backups: 'included' }, D0, D0 + 30 * DAY), new Date(D0 + 30 * DAY));
    expect(f.resolution).toBe('fine');
  });

  it('after a year the days are months: the same bytes, one point per month', async () => {
    const yearOn = new Date(D0 + 400 * DAY);
    await reapUsageMetrics(db, yearOn);
    const r = await db.execute<{ resolution: string; n: number }>(sql`
      SELECT resolution::text AS resolution, count(*)::int AS n FROM traffic_rollup GROUP BY 1 ORDER BY 1`);
    expect(r.rows).toEqual([{ resolution: 'monthly', n: expect.any(Number) }]);

    const f = await frameAt(ask({ scope: 'node', subject: 'n1', backups: 'included' }, D0 - 60 * DAY, yearOn.getTime()), yearOn);
    expect(f.resolution).toBe('monthly');
    expect(f.stepSeconds).toBe(MONTH_STEP_SECONDS);
    const march = Date.parse('2031-03-01T00:00:00Z');
    const out = at(f, 'out', march) ?? 0;
    expect(out * f.stepSeconds).toBeCloseTo(300 * 86_400, 0);

    const lat = await frameAt(ask({ scope: 'tenant', subject: A.ns, metric: 'latency', backups: 'included' }, D0 - 60 * DAY, yearOn.getTime()), yearOn);
    // 4 req/s at 30 ms on day one, 1 req/s at 90 ms on day two: (4·30 + 1·90) / 5.
    expect(at(lat, 'out', march)).toBeCloseTo((4 * 30 + 1 * 90) / 5);

    // A latency with no request count behind it reads back after the folds as it did hourly.
    const route = await frameAt(ask({ scope: 'route', subject: `${A.ns}-site`, metric: 'latency', backups: 'included' }, D0 - 60 * DAY, yearOn.getTime()), yearOn);
    expect(at(route, 'out', march)).toBeCloseTo(25);
  });

  it('a tenant’s billed egress folds into months too, instead of being deleted at a year', async () => {
    await recordHourlyUsage(db, A.id, { bandwidth_gb: 2 }, new Date(D0 + 3 * 3_600_000));
    await recordHourlyUsage(db, A.id, { bandwidth_gb: 3 }, new Date(D1 + 3 * 3_600_000));
    const yearOn = new Date(D0 + 400 * DAY);
    await reapUsageMetrics(db, new Date(D0 + 40 * DAY));
    await reapUsageMetrics(db, yearOn);
    const r = await db.execute<{ resolution: string; gb: number }>(sql`
      SELECT resolution::text AS resolution, sum(value)::float AS gb FROM usage_metrics WHERE tenant_id = ${A.id} GROUP BY 1`);
    expect(r.rows).toEqual([{ resolution: 'monthly', gb: 5 }]);
    const f = await frameAt(ask({ scope: 'tenant', subject: A.ns, backups: 'included' }, D0 - 60 * DAY, yearOn.getTime()), yearOn);
    expect(f.resolution).toBe('monthly');
    const march = Date.parse('2031-03-01T00:00:00Z');
    expect((at(f, A.id, march) ?? 0) * f.stepSeconds / 1e9).toBeCloseTo(5);
  });
});

d('the collector works through time from its watermark', () => {
  beforeAll(async () => {
    await runMigrations();
    await dropFixtures();
    await seedTenants();
  });
  afterAll(dropFixtures);

  it('backfills from the oldest hour the store holds, two days a pass, and resumes where it stopped', async () => {
    const now = new Date(D0 + 30 * DAY + 10 * 60_000);
    const first = await collectTrafficRollup({ db, fetchFrame, now: () => now });
    expect(first.spans).toBe(2);
    const oldest = D0 + 2 * 3_600_000; // the hour after the first whole hour inside 30 days
    expect(first.through).toBe(oldest + 2 * DAY);
    const second = await collectTrafficRollup({ db, fetchFrame, now: () => now });
    expect(second.through).toBe(oldest + 4 * DAY);
    const r = await db.execute<{ n: number }>(sql`SELECT count(DISTINCT bucket)::int AS n FROM traffic_rollup_coverage WHERE resolution = 'hourly'`);
    expect(r.rows[0].n).toBe(4 * 24);
  });

  it('one view failing costs that view a gap, not the span: the rest is kept and the watermark moves', async () => {
    failPods = true;
    try {
      const now = new Date(D0 + 30 * DAY + 10 * 60_000);
      const before = await collectTrafficRollup({ db, fetchFrame, now: () => now });
      const after = await collectTrafficRollup({ db, fetchFrame, now: () => now });
      expect(after.through).toBe((before.through ?? 0) + 2 * DAY);
      const span = (before.through ?? 0) + DAY;
      const r = await db.execute<{ scope: string; n: number }>(sql`
        SELECT scope, count(*)::int AS n FROM traffic_rollup_coverage
         WHERE resolution = 'hourly' AND bucket >= ${new Date(span)} AND namespace IN ('', ${A.ns})
         GROUP BY 1 ORDER BY 1`);
      // Pods of the failing tenant were not measured in those hours; everything else was.
      expect(r.rows.map((x) => x.scope)).toEqual(['cluster', 'node', 'route', 'tenant']);
    } finally {
      failPods = false;
    }
  });

  it('collects nothing and moves nothing when the store cannot answer', async () => {
    const before = await db.execute<{ value: string }>(sql`SELECT setting_value AS value FROM platform_settings WHERE setting_key = 'traffic_rollup_through'`);
    const failing = async () => { throw new Error('vmsingle: connection refused'); };
    await expect(collectTrafficRollup({ db, fetchFrame: failing, now: () => new Date(D0 + 30 * DAY + 10 * 60_000) }))
      .rejects.toThrow(/connection refused/);
    const after = await db.execute<{ value: string }>(sql`SELECT setting_value AS value FROM platform_settings WHERE setting_key = 'traffic_rollup_through'`);
    expect(after.rows).toEqual(before.rows);
  });
});

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb, runMigrations, isDbAvailable } from '../../test-helpers/db.js';
import { recordHourlyUsage, reapUsageMetrics } from '../metrics/usage-rollup.js';

/**
 * Long traffic ranges against the rollup the meter really writes.
 *
 * The rows are made the way production makes them: the meter's hourly writer,
 * then the daily reaper, which folds days older than 30 days into one row each
 * and deletes their hours. A range past metric retention is answered from
 * those rows, and reading only the folded ones drew nothing for the newest 30
 * days — "Last 30 days" was empty, 90 days and a year stopped a month short.
 *
 * The clock is years ahead, so no row written at the real time can land on a
 * day these tests expect to be a gap.
 */

const vmAsked: string[] = [];
vi.mock('../monitoring/vm-client.js', () => ({
  queryRange: (expr: string) => { vmAsked.push(expr); return Promise.resolve([]); },
  queryInstant: () => Promise.resolve([]),
}));

const { fetchTrafficFrame } = await import('./service.js');

const db = getTestDb();
const dbAvailable = await isDbAvailable();
const d = dbAvailable ? describe : describe.skip;

const NOW = new Date('2031-05-15T12:30:00Z');
const DAY = 86_400_000;
const BUSY = { id: 'tdf-busy-0000-0000-000000000001', ns: 'tenant-busy-fixture', name: 'Busy', created: '2031-01-01T00:00:00Z' };
const IDLE = { id: 'tdf-idle-0000-0000-000000000002', ns: 'tenant-idle-fixture', name: 'Idle', created: '2031-01-01T00:00:00Z' };
const LATE = { id: 'tdf-late-0000-0000-000000000003', ns: 'tenant-late-fixture', name: 'Late', created: '2031-04-30T09:00:00Z' };
const ALL = [BUSY, IDLE, LATE];

async function seedTenants(): Promise<void> {
  await db.execute(sql`
    INSERT INTO regions (id, code, name, provider, status, created_at)
    VALUES ('region-tdf', 'tdf', 'Tdf', 'hetzner', 'active', NOW())
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO hosting_plans (id, code, name, cpu_limit, memory_limit, storage_limit, monthly_price_usd, max_sub_users, status, created_at)
    VALUES ('plan-tdf', 'tdf', 'Tdf', 1, 1, 1, 0, 1, 'active', NOW())
    ON CONFLICT (id) DO NOTHING
  `);
  for (const t of ALL) {
    await db.execute(sql`
      INSERT INTO tenants (id, region_id, name, primary_email, status, kubernetes_namespace, plan_id, created_at, updated_at)
      VALUES (${t.id}, 'region-tdf', ${t.name}, 'tdf@example.test', 'active', ${t.ns}, 'plan-tdf', ${t.created}::timestamp, NOW())
      ON CONFLICT (id) DO NOTHING
    `);
  }
}

async function dropFixtures(): Promise<void> {
  // usage_metrics rows go with their tenant (ON DELETE CASCADE).
  await db.execute(sql`DELETE FROM tenants WHERE id IN (${BUSY.id}, ${IDLE.id}, ${LATE.id})`);
  await db.execute(sql`DELETE FROM hosting_plans WHERE id = 'plan-tdf'`);
  await db.execute(sql`DELETE FROM regions WHERE id = 'region-tdf'`);
}

/** The meter's write for one tick: GB sent in the hour ending at `at`. */
const meter = (tenantId: string, at: string, gb: number): Promise<void> =>
  recordHourlyUsage(db, tenantId, { bandwidth_gb: gb }, new Date(at));

const rate = (gb: number): number => (gb * 1e9) / 86_400;

type Frame = Awaited<ReturnType<typeof fetchTrafficFrame>>;

function request(days: number, subject?: string, extraMs = 0) {
  return {
    from: new Date(NOW.getTime() - days * DAY - extraMs),
    to: NOW,
    scope: 'tenant' as const,
    subject,
    metric: 'traffic' as const,
    direction: 'both' as const,
    backups: 'included' as const,
  };
}

const frameFor = (days: number, subject?: string, extraMs = 0): Promise<Frame> =>
  fetchTrafficFrame(request(days, subject, extraMs), { db, now: () => NOW });

function pointOn(frame: Frame, key: string, day: string): number | null | undefined {
  const i = frame.times.indexOf(new Date(`${day}T00:00:00Z`).toISOString());
  if (i < 0) return undefined;
  return frame.series.find((s) => s.key === key)?.points[i];
}

const totalGb = (frame: Frame, key: string): number =>
  (frame.series.find((s) => s.key === key)?.points ?? []).reduce<number>((a, v) => a + (v ?? 0), 0)
    * frame.stepSeconds / 1e9;

d('long traffic ranges read the whole rollup', () => {
  beforeAll(async () => {
    await runMigrations();
    await dropFixtures();
    await seedTenants();

    // Older than 30 days: folded by the reaper.
    await meter(BUSY.id, '2031-03-02T03:10:00Z', 1);
    await meter(BUSY.id, '2031-03-02T04:10:00Z', 2);
    await meter(BUSY.id, '2031-03-28T22:10:00Z', 0.5);
    // The newest 30 days: hourly rows, as the meter left them.
    await meter(BUSY.id, '2031-05-05T01:10:00Z', 0.25);
    await meter(BUSY.id, '2031-05-05T02:10:00Z', 0.25);
    await meter(BUSY.id, '2031-05-05T03:10:00Z', 0.25);
    await meter(BUSY.id, '2031-05-15T10:10:00Z', 0.1);
    await meter(LATE.id, '2031-05-05T05:10:00Z', 2);
    // IDLE sent nothing, so the meter wrote nothing for it.

    await reapUsageMetrics(db, NOW);
  });
  afterAll(dropFixtures);

  it('starts from the shape production has: folded days before the 30-day cutoff, hours after it', async () => {
    const r = await db.execute<{ day: string; resolution: string; n: number }>(sql`
      SELECT to_char(measurement_timestamp, 'YYYY-MM-DD') AS day, resolution::text AS resolution, count(*)::int AS n
        FROM usage_metrics WHERE tenant_id = ${BUSY.id}
       GROUP BY 1, 2 ORDER BY 1
    `);
    expect(r.rows).toEqual([
      { day: '2031-03-02', resolution: 'daily', n: 1 },
      { day: '2031-03-28', resolution: 'daily', n: 1 },
      { day: '2031-05-05', resolution: 'hourly', n: 3 },
      { day: '2031-05-15', resolution: 'hourly', n: 1 },
    ]);
  });

  it('90 days: the folded days AND the newest month, each hour summed into its day', async () => {
    const f = await frameFor(90, BUSY.ns);
    expect(f.resolution).toBe('daily');
    expect(pointOn(f, BUSY.id, '2031-03-02')).toBeCloseTo(rate(3));
    expect(pointOn(f, BUSY.id, '2031-03-28')).toBeCloseTo(rate(0.5));
    expect(pointOn(f, BUSY.id, '2031-05-05')).toBeCloseTo(rate(0.75));
    // Today so far, over the whole day: the total stays what was billed.
    expect(pointOn(f, BUSY.id, '2031-05-15')).toBeCloseTo(rate(0.1));
    expect(totalGb(f, BUSY.id)).toBeCloseTo(3 + 0.5 + 0.75 + 0.1);
  });

  it('a year: the same days, nothing counted twice', async () => {
    const f = await frameFor(365, BUSY.ns);
    expect(totalGb(f, BUSY.id)).toBeCloseTo(4.35);
  });

  it('a day nobody was measured stays a gap; a measured day without traffic is zero', async () => {
    const f = await frameFor(90, BUSY.ns);
    expect(pointOn(f, BUSY.id, '2031-02-20')).toBeNull();
    expect(pointOn(f, BUSY.id, '2031-05-11')).toBeNull();

    const idle = await frameFor(90, IDLE.ns);
    expect(idle.series.map((s) => s.name)).toEqual(['Idle']);
    expect(pointOn(idle, IDLE.id, '2031-03-02')).toBe(0);
    expect(pointOn(idle, IDLE.id, '2031-05-05')).toBe(0);
    expect(pointOn(idle, IDLE.id, '2031-02-20')).toBeNull();
  });

  it('a tenant created mid-range has no zeros before it existed', async () => {
    const f = await frameFor(90, LATE.ns);
    expect(pointOn(f, LATE.id, '2031-03-28')).toBeNull();
    expect(pointOn(f, LATE.id, '2031-05-05')).toBeCloseTo(rate(2));
    expect(pointOn(f, LATE.id, '2031-05-15')).toBe(0);
  });

  it('every tenant at once: each one complete, and a measured day is zero for the quiet one', async () => {
    const f = await frameFor(90);
    expect(totalGb(f, BUSY.id)).toBeCloseTo(4.35);
    expect(totalGb(f, LATE.id)).toBeCloseTo(2);
    expect(pointOn(f, LATE.id, '2031-05-05')).toBeCloseTo(rate(2));
    expect(pointOn(f, LATE.id, '2031-03-02')).toBeNull();
    expect(pointOn(f, BUSY.id, '2031-02-20')).toBeNull();
  });

  it('a range starting mid-day leaves that partial day out of both the points and the total', async () => {
    const f = await fetchTrafficFrame(
      { ...request(0), from: new Date('2031-05-05T02:30:00Z') },
      { db, now: () => new Date('2031-07-01T00:00:00Z') },
    );
    expect(f.resolution).toBe('daily');
    expect(f.times[0]).toBe('2031-05-06T00:00:00.000Z');
    expect(totalGb(f, BUSY.id)).toBeCloseTo(0.1);
  });

  it('"Last 30 days" from a browser is answered from the metrics store, not the rollup', async () => {
    vmAsked.length = 0;
    const f = await frameFor(30, BUSY.ns, 50);
    expect(f.resolution).toBe('fine');
    expect(f.clamped).toBe(false);
    expect(vmAsked.length).toBeGreaterThan(0);
  });

  it('a 30-day range left open for hours reads the rollup, and the newest month is in it', async () => {
    const f = await frameFor(30, BUSY.ns, 5 * 3_600_000);
    expect(f.resolution).toBe('daily');
    expect(pointOn(f, BUSY.id, '2031-05-05')).toBeCloseTo(rate(0.75));
    expect(pointOn(f, BUSY.id, '2031-05-15')).toBeCloseTo(rate(0.1));
  });
});

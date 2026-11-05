/**
 * Per-tenant traffic past metric retention, served from the bandwidth meter's
 * rollup in `usage_metrics` instead of the metrics store.
 */

import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { TrafficFrame, TrafficUnit } from '@insula/api-contracts';
import { tenants, usageMetrics } from '../../db/schema.js';
import { buildTimeline, foldTail } from './frame.js';
import type { Database } from '../../db/index.js';
import type { TrafficRequest } from './service.js';

const DAY_MS = 86_400_000;

/** One tenant's egress per UTC day, as the rollup stores it. */
interface EgressDays {
  readonly name: string;
  readonly createdAt: Date;
  /** Day start (ms) → GB from the folded daily row, and GB summed from hourly rows. */
  readonly days: Map<number, { daily: number | null; hourly: number }>;
}

/** The stored timestamps are UTC without a zone, so epoch ÷ 86400 is the UTC day number. */
const utcDay = sql<number>`floor(extract(epoch from ${usageMetrics.measurementTimestamp}) / 86400)::int`;

/**
 * The rollup in range, summed per tenant, UTC day and resolution, plus every
 * day the meter wrote a row for anyone.
 */
async function readEgressRollup(
  req: TrafficRequest, db: Database,
): Promise<{ byTenant: Map<string, EgressDays>; meteredDays: Set<number> }> {
  const inRange = and(
    eq(usageMetrics.metricType, 'bandwidth_gb'),
    gte(usageMetrics.measurementTimestamp, req.from),
    lte(usageMetrics.measurementTimestamp, req.to),
  );
  const [rows, meteredForSubject, subjectTenant] = await Promise.all([
    db.select({
      tenantId: usageMetrics.tenantId,
      day: utcDay.mapWith(Number),
      resolution: usageMetrics.resolution,
      gb: sql<number>`sum(${usageMetrics.value})`.mapWith(Number),
      name: tenants.name,
      createdAt: tenants.createdAt,
    })
      .from(usageMetrics)
      .innerJoin(tenants, eq(tenants.id, usageMetrics.tenantId))
      .where(and(inRange, req.subject ? eq(tenants.kubernetesNamespace, req.subject) : sql`true`))
      .groupBy(usageMetrics.tenantId, utcDay, usageMetrics.resolution, tenants.name, tenants.createdAt),
    // Every tenant's rows are already in hand when no subject narrows the read.
    req.subject
      ? db.selectDistinct({ day: utcDay.mapWith(Number) }).from(usageMetrics).where(inRange)
      : Promise.resolve(null),
    req.subject
      ? db.select({ id: tenants.id, name: tenants.name, createdAt: tenants.createdAt })
        .from(tenants).where(eq(tenants.kubernetesNamespace, req.subject)).limit(1)
      : Promise.resolve([]),
  ]);

  const byTenant = new Map<string, EgressDays>();
  // A tenant asked for by name gets its row even when the meter wrote nothing for it.
  for (const t of subjectTenant) byTenant.set(t.id, { name: t.name, createdAt: t.createdAt, days: new Map() });
  for (const r of rows) {
    const entry = byTenant.get(r.tenantId) ?? { name: r.name, createdAt: r.createdAt, days: new Map() };
    const day = r.day * DAY_MS;
    const seen = entry.days.get(day) ?? { daily: null, hourly: 0 };
    entry.days.set(day, r.resolution === 'daily'
      ? { ...seen, daily: (seen.daily ?? 0) + r.gb }
      : { ...seen, hourly: seen.hourly + r.gb });
    byTenant.set(r.tenantId, entry);
  }
  const metered = meteredForSubject ?? rows;
  return { byTenant, meteredDays: new Set(metered.map((m) => m.day * DAY_MS)) };
}

/**
 * GB for one tenant on the day starting at `day`, or null when nobody measured it.
 *
 * The meter skips an hour that carried nothing, so a missing row is not a
 * missing measurement: on a day the meter wrote rows for anyone, a tenant that
 * already existed and has no row sent nothing. Days the meter never covered
 * stay null, so they draw as a gap and not as a quiet stretch.
 */
function egressOnDay(e: EgressDays, day: number, meteredDays: ReadonlySet<number>): number | null {
  const stored = e.days.get(day);
  // The reaper folds a day and deletes its hours in one transaction, so a day
  // holds one or the other; the folded row wins should both ever be present.
  if (stored) return stored.daily ?? stored.hourly;
  return meteredDays.has(day) && e.createdAt.getTime() < day + DAY_MS ? 0 : null;
}

/**
 * Per-tenant egress beyond metric retention, from the meter's rollup.
 *
 * The rollup keeps the newest 30 days as hourly rows and folds each older day
 * into one daily row, so a range reaching past retention needs both: the
 * daily rows for the old part, and the hourly rows summed per UTC day for the
 * recent part. Reading the daily rows alone left out the newest 30 days.
 *
 * These rows are GB already billed, so the frame reports a rate derived from
 * them rather than re-deriving one: GB ÷ 86400 gives bytes/s over the day,
 * which is what the chart's y-axis means everywhere else. Today is divided by
 * the whole day too, so its point is the day so far and sits low until the day
 * ends; dividing by the hours elapsed would draw a truer rate but make the
 * range's total, which the panel takes as Σ point × step, larger than billed.
 */
export async function dailyTenantFrame(req: TrafficRequest, db: Database, unit: TrafficUnit): Promise<TrafficFrame> {
  const { byTenant, meteredDays } = await readEgressRollup(req, db);

  const stepSeconds = 86_400;
  const timeline = buildTimeline(req.from.getTime(), req.to.getTime(), stepSeconds);
  const ranked = [...byTenant.entries()].map(([id, e]) => ({
    key: id,
    name: e.name,
    points: timeline.map((t) => {
      const gb = egressOnDay(e, t, meteredDays);
      // GB over the day → bytes per second, the unit every other frame uses.
      return gb === null ? null : (gb * 1e9) / stepSeconds;
    }),
  }));
  const folded = foldTail(ranked, unit, stepSeconds);

  return {
    from: req.from.toISOString(),
    to: req.to.toISOString(),
    stepSeconds,
    times: timeline.map((t) => new Date(t).toISOString()),
    unit,
    resolution: 'daily',
    series: req.subject
      ? ranked.map((r) => ({ key: r.key, name: r.name, kind: 'direction' as const, points: r.points }))
      : folded.series,
    othersFolded: req.subject ? 0 : folded.othersFolded,
    clamped: false,
  };
}

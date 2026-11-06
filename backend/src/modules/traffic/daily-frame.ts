/**
 * Per-tenant traffic past metric retention, served from the bandwidth meter's
 * rollup in `usage_metrics` instead of the metrics store.
 */

import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { TrafficFrame, TrafficUnit } from '@insula/api-contracts';
import { tenants, usageMetrics } from '../../db/schema.js';
import { foldTail } from './frame.js';
import {
  periodBucketSql, periodEnd, periodFor, periodStepSeconds, periodTimeline, type RollupPeriod,
} from './rollup-period.js';
import type { Database } from '../../db/index.js';
import type { TrafficRequest } from './service.js';

/** One tenant's egress per bucket, as the rollup stores it. */
interface EgressBuckets {
  readonly name: string;
  readonly createdAt: Date;
  /** Bucket start (ms) → GB. */
  readonly gb: Map<number, number>;
}

/**
 * The rollup in range, summed per tenant and bucket, plus every bucket the
 * meter wrote a row for anyone in.
 *
 * Every resolution is summed together. The reaper folds a day (or a month)
 * and deletes what it folded in one transaction, so no hour is ever stored
 * twice — and a month still inside the year holds daily rows for its older
 * days and hourly rows for its newest, which have to be added up.
 */
async function readEgressRollup(
  req: TrafficRequest, db: Database, period: RollupPeriod,
): Promise<{ byTenant: Map<string, EgressBuckets>; metered: Set<number> }> {
  const bucket = periodBucketSql(period, usageMetrics.measurementTimestamp);
  const inRange = and(
    eq(usageMetrics.metricType, 'bandwidth_gb'),
    gte(usageMetrics.measurementTimestamp, req.from),
    lte(usageMetrics.measurementTimestamp, req.to),
  );
  const [rows, meteredForSubject, subjectTenant] = await Promise.all([
    db.select({
      tenantId: usageMetrics.tenantId,
      bucket: bucket.mapWith(Number),
      gb: sql<number>`sum(${usageMetrics.value})`.mapWith(Number),
      name: tenants.name,
      createdAt: tenants.createdAt,
    })
      .from(usageMetrics)
      .innerJoin(tenants, eq(tenants.id, usageMetrics.tenantId))
      .where(and(inRange, req.subject ? eq(tenants.kubernetesNamespace, req.subject) : sql`true`))
      .groupBy(usageMetrics.tenantId, bucket, tenants.name, tenants.createdAt),
    // Every tenant's rows are already in hand when no subject narrows the read.
    req.subject
      ? db.selectDistinct({ bucket: bucket.mapWith(Number) }).from(usageMetrics).where(inRange)
      : Promise.resolve(null),
    req.subject
      ? db.select({ id: tenants.id, name: tenants.name, createdAt: tenants.createdAt })
        .from(tenants).where(eq(tenants.kubernetesNamespace, req.subject)).limit(1)
      : Promise.resolve([]),
  ]);

  const byTenant = new Map<string, EgressBuckets>();
  // A tenant asked for by name gets its row even when the meter wrote nothing for it.
  for (const t of subjectTenant) byTenant.set(t.id, { name: t.name, createdAt: t.createdAt, gb: new Map() });
  for (const r of rows) {
    const entry = byTenant.get(r.tenantId) ?? { name: r.name, createdAt: r.createdAt, gb: new Map() };
    entry.gb.set(r.bucket, (entry.gb.get(r.bucket) ?? 0) + r.gb);
    byTenant.set(r.tenantId, entry);
  }
  return { byTenant, metered: new Set((meteredForSubject ?? rows).map((m) => m.bucket)) };
}

/**
 * GB for one tenant in the bucket starting at `start`, or null when nobody measured it.
 *
 * The meter skips an hour that carried nothing, so a missing row is not a
 * missing measurement: in a bucket the meter wrote rows for anyone in, a
 * tenant that already existed and has no row sent nothing. Buckets the meter
 * never covered stay null, so they draw as a gap and not as a quiet stretch.
 */
function egressIn(e: EgressBuckets, start: number, period: RollupPeriod, metered: ReadonlySet<number>): number | null {
  const stored = e.gb.get(start);
  if (stored !== undefined) return stored;
  return metered.has(start) && e.createdAt.getTime() < periodEnd(period, start) ? 0 : null;
}

/**
 * Per-tenant egress beyond metric retention, from the meter's rollup.
 *
 * The rollup keeps the newest 30 days as hourly rows, folds each older day
 * into one daily row and each month older than a year into one monthly row,
 * so a range reaching past retention needs all of them: drawn one point per
 * UTC day within a year, one per UTC month beyond. Reading the daily rows
 * alone left out the newest 30 days.
 *
 * These rows are GB already billed, so the frame reports a rate derived from
 * them rather than re-deriving one: GB ÷ the step gives bytes/s over the
 * bucket, which is what the chart's y-axis means everywhere else. The current
 * bucket is divided by the whole step too, so its point is the bucket so far
 * and sits low until it ends; dividing by the time elapsed would draw a truer
 * rate but make the range's total, which the panel takes as Σ point × step,
 * larger than billed.
 */
export async function rollupTenantFrame(
  req: TrafficRequest, db: Database, unit: TrafficUnit, now: Date,
): Promise<TrafficFrame> {
  const period = periodFor(req.from, now);
  const { byTenant, metered } = await readEgressRollup(req, db, period);

  const stepSeconds = periodStepSeconds(period);
  const timeline = periodTimeline(period, req.from.getTime(), req.to.getTime());
  const ranked = [...byTenant.entries()].map(([id, e]) => ({
    key: id,
    name: e.name,
    points: timeline.map((t) => {
      const gb = egressIn(e, t, period, metered);
      // GB over the bucket → bytes per second, the unit every other frame uses.
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
    resolution: period,
    series: req.subject
      ? ranked.map((r) => ({ key: r.key, name: r.name, kind: 'direction' as const, points: r.points }))
      : folded.series,
    othersFolded: req.subject ? 0 : folded.othersFolded,
    clamped: false,
  };
}

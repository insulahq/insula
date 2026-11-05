/**
 * The traffic rollup's tables: writing an hour, and folding hours into days
 * and days into months.
 *
 * A series is one line a traffic graph draws (a measurement, one direction,
 * one subject); its values are bytes or requests per bucket, or for latency a
 * mean in milliseconds weighted by the requests behind it. Coverage records
 * which buckets were measured at all, so the reader can tell a quiet hour
 * (measured, no row) from one nobody saw (not covered).
 */

import { eq, sql } from 'drizzle-orm';
import {
  platformSettings, trafficRollup, trafficRollupCoverage, trafficRollupSeries,
} from '../../db/schema.js';
import type { Database } from '../../db/index.js';

export interface RollupSeriesIdentity {
  readonly scope: string;
  readonly metric: string;
  readonly seriesKey: string;
  readonly direction: 'in' | 'out';
  readonly subject: string | null;
  readonly namespace: string | null;
  readonly ref: string | null;
  readonly name: string;
  readonly kind: string;
  readonly grp: string | null;
}

export interface RollupHourValue {
  readonly value: number;
  readonly weight: number | null;
}

export interface RollupSeriesHours {
  readonly identity: RollupSeriesIdentity;
  /** Hour start (ms) → the hour's value. */
  readonly hours: ReadonlyMap<number, RollupHourValue>;
}

/** An hour one view measured, in one direction (for a pod view, in one tenant). */
export interface RollupCoveredHour {
  readonly scope: string;
  readonly metric: string;
  readonly direction: 'in' | 'out';
  readonly namespace: string;
  readonly hour: number;
}

const BATCH = 500;
const WATERMARK_KEY = 'traffic_rollup_through';

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Write one collected span: every series seen, its hourly values, and the
 * hours that were measured. Idempotent — a span written twice holds the same
 * rows, so a tick that fails half way is simply collected again.
 */
export async function writeRollupHours(
  db: Database, series: readonly RollupSeriesHours[], covered: readonly RollupCoveredHour[],
): Promise<void> {
  await db.transaction(async (tx) => {
    const ids = new Map<string, number>();
    for (const batch of chunks(series, BATCH)) {
      const rows = await tx.insert(trafficRollupSeries)
        .values(batch.map(({ identity: i }) => ({ ...i, lastSeenAt: new Date() })))
        .onConflictDoUpdate({
          target: [trafficRollupSeries.scope, trafficRollupSeries.metric, trafficRollupSeries.seriesKey],
          set: {
            direction: sql`excluded.direction`,
            subject: sql`excluded.subject`,
            namespace: sql`excluded.namespace`,
            ref: sql`excluded.ref`,
            name: sql`excluded.name`,
            kind: sql`excluded.kind`,
            grp: sql`excluded.grp`,
            lastSeenAt: sql`excluded.last_seen_at`,
          },
        })
        .returning({
          id: trafficRollupSeries.id, scope: trafficRollupSeries.scope,
          metric: trafficRollupSeries.metric, seriesKey: trafficRollupSeries.seriesKey,
        });
      for (const r of rows) ids.set(`${r.scope}|${r.metric}|${r.seriesKey}`, r.id);
    }

    const values = series.flatMap(({ identity: i, hours }) => {
      const seriesId = ids.get(`${i.scope}|${i.metric}|${i.seriesKey}`);
      if (seriesId === undefined) return [];
      return [...hours.entries()].map(([hour, v]) => ({
        seriesId, resolution: 'hourly' as const, bucket: new Date(hour), value: v.value, weight: v.weight,
      }));
    });
    for (const batch of chunks(values, BATCH)) {
      await tx.insert(trafficRollup).values(batch).onConflictDoUpdate({
        target: [trafficRollup.seriesId, trafficRollup.resolution, trafficRollup.bucket],
        set: { value: sql`excluded.value`, weight: sql`excluded.weight` },
      });
    }

    const coverage = covered.map(({ hour, ...view }) => ({ ...view, resolution: 'hourly' as const, bucket: new Date(hour) }));
    for (const batch of chunks(coverage, BATCH)) {
      await tx.insert(trafficRollupCoverage).values(batch).onConflictDoNothing();
    }
  });
}

/** The end of the last span collected (an hour boundary, ms), or null before the first. */
export async function readRollupWatermark(db: Database): Promise<number | null> {
  const [row] = await db.select({ value: platformSettings.value })
    .from(platformSettings).where(eq(platformSettings.key, WATERMARK_KEY));
  const t = row?.value ? Date.parse(row.value) : Number.NaN;
  return Number.isFinite(t) ? t : null;
}

export async function writeRollupWatermark(db: Database, through: number): Promise<void> {
  const value = new Date(through).toISOString();
  await db.insert(platformSettings).values({ key: WATERMARK_KEY, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value } });
}

/**
 * Fold one resolution into the next for every bucket before `cutoff`, then
 * delete what was folded. Bytes and requests add up; a latency mean is
 * weighted by the requests behind it, and the weights add up. A latency hour
 * with no request count weighs 1, here as in the reader, so a folded day
 * reads back the same as its hours did.
 */
async function foldInto(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  from: 'hourly' | 'daily', to: 'daily' | 'monthly', unit: 'day' | 'month', cutoff: Date,
): Promise<void> {
  // Inlined, not bound: GROUP BY must see the very expression the SELECT
  // list has, and two placeholders are two expressions to Postgres. `unit`
  // is one of two literals.
  const trunc = sql.raw(`'${unit}'`);
  await tx.execute(sql`
    INSERT INTO traffic_rollup (series_id, resolution, bucket, value, weight)
    SELECT r.series_id, ${to}::usage_resolution, date_trunc(${trunc}, r.bucket),
           CASE WHEN s.metric = 'latency'
                THEN coalesce(sum(r.value * coalesce(r.weight, 1)) / nullif(sum(coalesce(r.weight, 1)), 0), avg(r.value))
                ELSE sum(r.value) END,
           CASE WHEN s.metric = 'latency' THEN sum(coalesce(r.weight, 1)) END
      FROM traffic_rollup r
      JOIN traffic_rollup_series s ON s.id = r.series_id
     WHERE r.resolution = ${from}::usage_resolution AND r.bucket < ${cutoff}
     GROUP BY r.series_id, s.metric, date_trunc(${trunc}, r.bucket)
    ON CONFLICT (series_id, resolution, bucket)
    DO UPDATE SET value = excluded.value, weight = excluded.weight
  `);
  await tx.execute(sql`
    DELETE FROM traffic_rollup WHERE resolution = ${from}::usage_resolution AND bucket < ${cutoff}
  `);
  await tx.execute(sql`
    INSERT INTO traffic_rollup_coverage (scope, metric, direction, namespace, resolution, bucket)
    SELECT DISTINCT scope, metric, direction, namespace, ${to}::usage_resolution, date_trunc(${trunc}, bucket)
      FROM traffic_rollup_coverage
     WHERE resolution = ${from}::usage_resolution AND bucket < ${cutoff}
    ON CONFLICT DO NOTHING
  `);
  await tx.execute(sql`
    DELETE FROM traffic_rollup_coverage WHERE resolution = ${from}::usage_resolution AND bucket < ${cutoff}
  `);
}

/**
 * The daily reaper's traffic half, on the cutoffs `reapUsageMetrics` uses:
 * hours older than 30 days become days, days older than a year become months,
 * months older than five years go. A series nothing refers to any more, and
 * that no collection has seen for 30 days, goes with them.
 */
export async function reapTrafficRollup(
  db: Database, cutoffs: { hourlyCutoff: Date; dailyCutoff: Date; monthlyCutoff: Date },
): Promise<void> {
  await db.transaction(async (tx) => {
    await foldInto(tx, 'hourly', 'daily', 'day', cutoffs.hourlyCutoff);
    await foldInto(tx, 'daily', 'monthly', 'month', cutoffs.dailyCutoff);
    await tx.execute(sql`DELETE FROM traffic_rollup WHERE resolution = 'monthly' AND bucket < ${cutoffs.monthlyCutoff}`);
    await tx.execute(sql`DELETE FROM traffic_rollup_coverage WHERE resolution = 'monthly' AND bucket < ${cutoffs.monthlyCutoff}`);
    await tx.execute(sql`
      DELETE FROM traffic_rollup_series s
       WHERE s.last_seen_at < ${cutoffs.hourlyCutoff}
         AND NOT EXISTS (SELECT 1 FROM traffic_rollup r WHERE r.series_id = s.id)
    `);
  });
}

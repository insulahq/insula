/**
 * Any traffic graph past metric retention, drawn from the traffic rollup.
 *
 * The collector stores each view's full breakdown, one series per subject and
 * direction, under the keys and names the live frame gives them. This builds
 * the frame a request would have got, one point per UTC day (or month):
 *
 *   • cluster        — its rows as stored, in their usual order;
 *   • a breakdown    — one row per subject, folded into `Other` past the top N;
 *   • one subject    — that subject's rows added up per direction, named the
 *                      way the live frame names them.
 *
 * A bucket the collector measured and a series has no row in moved nothing,
 * so it is zero; a bucket nobody measured is a gap.
 */

import { and, eq, gte, inArray, like, lte, sql, type SQL } from 'drizzle-orm';
import type { TrafficFrame, TrafficSeries, TrafficUnit } from '@insula/api-contracts';
import { tenants, trafficRollup, trafficRollupCoverage, trafficRollupSeries } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { foldTail } from './frame.js';
import {
  periodBucketSql, periodFor, periodStepSeconds, periodTimeline, type RollupPeriod,
} from './rollup-period.js';
import {
  belongsToNested, clusterRowRank, disambiguateNames, nestedNamespaces, prettyPodName,
  type FrameOptions, type TrafficRequest,
} from './service.js';

/** True when the rollup keeps what `req` asks for. */
export function rollupAnswers(req: TrafficRequest): boolean {
  if (req.scope === 'backup-class') return false;
  if (req.scope === 'cluster') return true;
  if (req.scope === 'pod' && req.metric !== 'traffic') return false;
  // A backup split is collected for the cluster view only.
  return req.metric !== 'traffic' || req.backups === 'included';
}

interface StoredSeries {
  readonly id: number;
  readonly key: string;
  readonly direction: string;
  readonly namespace: string | null;
  readonly ref: string | null;
  readonly name: string;
  readonly kind: string;
  readonly grp: string | null;
}

/**
 * The stored series this request draws from.
 *
 * A tenant's own route view is a tenant boundary: its services are the ones
 * whose name starts with its namespace, minus any tenant nested inside it.
 * That holds whether or not one route is asked for — the API checks a route
 * subject before it gets here, and this does not lean on that.
 */
async function selectSeries(req: TrafficRequest, db: Database): Promise<StoredSeries[]> {
  const conds: SQL[] = [eq(trafficRollupSeries.scope, req.scope), eq(trafficRollupSeries.metric, req.metric)];
  if (req.metric === 'traffic' && req.direction !== 'both') conds.push(eq(trafficRollupSeries.direction, req.direction));
  if (req.scope === 'pod') {
    if (req.subject) conds.push(eq(trafficRollupSeries.namespace, req.subject));
    if (req.pod) conds.push(eq(trafficRollupSeries.subject, prettyPodName(req.pod)));
  } else if (req.scope !== 'cluster' && req.subject) {
    conds.push(eq(trafficRollupSeries.subject, req.subject));
  }
  if (req.scope === 'route' && req.restrictToNamespace) {
    conds.push(like(trafficRollupSeries.subject, `${likeEscape(req.restrictToNamespace)}-%`));
  }
  const rows = await db.select({
    id: trafficRollupSeries.id, key: trafficRollupSeries.seriesKey, direction: trafficRollupSeries.direction,
    namespace: trafficRollupSeries.namespace, ref: trafficRollupSeries.ref, name: trafficRollupSeries.name,
    kind: trafficRollupSeries.kind, grp: trafficRollupSeries.grp,
  }).from(trafficRollupSeries).where(and(...conds));

  if (req.scope !== 'route' || !req.restrictToNamespace) return rows;
  // Namespaces nest (`tenant-a-…` inside `tenant-a-…-b-…`), so the prefix
  // alone hands a parent its child's routes — settled against the real list.
  const nested = await nestedNamespaces(db, req.restrictToNamespace);
  const own = rows.filter((r) => !belongsToNested(r.ref ?? '', nested));
  return tenantViewNames(db, req.restrictToNamespace, own);
}

/** `%` and `_` are wildcards to LIKE; a namespace is matched literally. */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Route names as the tenant's own panel shows them. The collector names a
 * route the way an operator reads it, `<route> · <tenant>`; a tenant looking
 * at its own routes is not told whose they are.
 */
async function tenantViewNames(db: Database, namespace: string, rows: StoredSeries[]): Promise<StoredSeries[]> {
  const [owner] = await db.select({ name: tenants.name }).from(tenants)
    .where(eq(tenants.kubernetesNamespace, namespace)).limit(1);
  if (!owner) return rows;
  const suffix = ` · ${owner.name}`;
  return rows.map((r) => (r.name.endsWith(suffix) ? { ...r, name: r.name.slice(0, -suffix.length) } : r));
}

/** Per series id, bucket start → { value, weight }: the rows in range, added up per bucket. */
async function readBuckets(
  db: Database, ids: readonly number[], req: TrafficRequest, period: RollupPeriod,
): Promise<Map<number, Map<number, { sum: number; weight: number }>>> {
  const out = new Map<number, Map<number, { sum: number; weight: number }>>();
  if (ids.length === 0) return out;
  const bucket = periodBucketSql(period, trafficRollup.bucket);
  const latency = req.metric === 'latency';
  const rows = await db.select({
    seriesId: trafficRollup.seriesId,
    bucket: bucket.mapWith(Number),
    // Latency: Σ mean × requests, and Σ requests, so the bucket's mean is weighted.
    sum: (latency
      ? sql<number>`sum(${trafficRollup.value} * coalesce(${trafficRollup.weight}, 1))`
      : sql<number>`sum(${trafficRollup.value})`).mapWith(Number),
    weight: sql<number>`sum(coalesce(${trafficRollup.weight}, 1))`.mapWith(Number),
  }).from(trafficRollup)
    .where(and(
      inArray(trafficRollup.seriesId, [...ids]),
      gte(trafficRollup.bucket, req.from),
      lte(trafficRollup.bucket, req.to),
    ))
    .groupBy(trafficRollup.seriesId, bucket);
  for (const r of rows) {
    const m = out.get(r.seriesId) ?? new Map();
    m.set(r.bucket, { sum: r.sum, weight: r.weight });
    out.set(r.seriesId, m);
  }
  return out;
}

/** Measured buckets of this view, by `<direction>|<namespace>` (namespace '' outside pod views). */
async function readCoverage(db: Database, req: TrafficRequest, period: RollupPeriod): Promise<Map<string, Set<number>>> {
  const bucket = periodBucketSql(period, trafficRollupCoverage.bucket);
  const rows = await db.selectDistinct({
    direction: trafficRollupCoverage.direction, namespace: trafficRollupCoverage.namespace, bucket: bucket.mapWith(Number),
  }).from(trafficRollupCoverage)
    .where(and(
      eq(trafficRollupCoverage.scope, req.scope),
      eq(trafficRollupCoverage.metric, req.metric),
      gte(trafficRollupCoverage.bucket, req.from),
      lte(trafficRollupCoverage.bucket, req.to),
    ));
  const out = new Map<string, Set<number>>();
  for (const r of rows) {
    const k = `${r.direction}|${r.namespace}`;
    out.set(k, (out.get(k) ?? new Set()).add(r.bucket));
  }
  return out;
}

/**
 * One point per bucket from the stored buckets of the series in `ids`, added
 * together: a rate for bytes and requests, a weighted mean for latency.
 */
function pointsFor(
  ids: readonly number[], buckets: Map<number, Map<number, { sum: number; weight: number }>>,
  timeline: readonly number[], covered: ReadonlySet<number>, latency: boolean, stepSeconds: number,
): Array<number | null> {
  return timeline.map((t) => {
    let sum = 0;
    let weight = 0;
    let any = false;
    for (const id of ids) {
      const b = buckets.get(id)?.get(t);
      if (!b) continue;
      sum += b.sum;
      weight += b.weight;
      any = true;
    }
    if (latency) return any && weight > 0 ? sum / weight : null;
    if (any) return sum / stepSeconds;
    return covered.has(t) ? 0 : null;
  });
}

const DIRECTION_LABEL = { out: 'Outbound', in: 'Inbound' } as const;

/** One subject's rows per direction, named as the live frame names a single subject. */
function singleSubjectSeries(
  req: TrafficRequest, series: readonly StoredSeries[], point: Point,
): TrafficSeries[] {
  const ns = req.scope === 'pod' ? req.subject ?? '' : '';
  if (req.metric !== 'traffic') {
    // The live frame names a single requests or latency line by its fallback key.
    return [{ key: 'out', name: 'out', kind: 'direction', points: point(series.map((s) => s.id), 'out', ns) }];
  }
  const directions = req.direction === 'both' ? (['out', 'in'] as const) : [req.direction];
  return directions.map((d) => ({
    key: d, name: DIRECTION_LABEL[d], kind: 'direction' as const,
    points: point(series.filter((s) => s.direction === d).map((s) => s.id), d, ns),
  }));
}

/** The points of some stored series added together, judged against one view's coverage. */
type Point = (ids: number[], direction: string, namespace: string) => Array<number | null>;

function isSingleSubject(req: TrafficRequest): boolean {
  if (req.scope === 'pod') return Boolean(req.pod);
  return req.scope !== 'cluster' && Boolean(req.subject);
}

export async function rollupFrame(
  req: TrafficRequest, db: Database, unit: TrafficUnit, now: Date, opts: FrameOptions = {},
): Promise<TrafficFrame> {
  const period = periodFor(req.from, now);
  const stepSeconds = periodStepSeconds(period);
  const timeline = periodTimeline(period, req.from.getTime(), req.to.getTime());
  const series = await selectSeries(req, db);
  const [buckets, covered] = await Promise.all([
    readBuckets(db, series.map((s) => s.id), req, period),
    readCoverage(db, req, period),
  ]);
  const latency = req.metric === 'latency';
  const none = new Set<number>();
  const point: Point = (ids, direction, namespace) => pointsFor(
    ids, buckets, timeline, covered.get(`${direction}|${namespace}`) ?? none, latency, stepSeconds,
  );
  const present = series.filter((s) => buckets.has(s.id));

  let out: TrafficSeries[];
  let othersFolded = 0;
  if (req.scope === 'cluster') {
    out = present
      .sort((a, b) => clusterRowRank(a.key) - clusterRowRank(b.key))
      .map((s) => ({
        key: s.key, name: s.name, kind: s.kind as TrafficSeries['kind'],
        ...(s.grp ? { group: s.grp as TrafficSeries['group'] } : {}),
        points: point([s.id], s.direction, ''),
      }));
  } else if (isSingleSubject(req)) {
    out = singleSubjectSeries(req, series, point);
  } else {
    const both = req.metric === 'traffic' && req.direction === 'both';
    // Outbound before inbound, as the live frame gathers them; then by name,
    // so the order does not change between refreshes.
    const ordered = [...present].sort((a, b) => (a.direction === b.direction ? a.name.localeCompare(b.name) : a.direction === 'out' ? -1 : 1));
    const rows = disambiguateNames(ordered.map((s) => {
      const name = both ? `${s.name} · ${s.direction}` : s.name;
      return {
        // The live frame keys a pod row by its application's name (one row
        // stands for every replica), and everything else by direction and subject.
        key: req.scope === 'pod' ? name : `${s.direction}:${s.ref ?? s.key}`,
        name,
        points: point([s.id], s.direction, s.namespace ?? ''),
      };
    }));
    if (opts.noFold) {
      out = rows.map((r) => ({ ...r, kind: 'subject' as const }));
    } else {
      const folded = foldTail(rows, unit, stepSeconds);
      out = folded.series;
      othersFolded = folded.othersFolded;
    }
  }

  return {
    from: req.from.toISOString(),
    to: req.to.toISOString(),
    stepSeconds,
    times: timeline.map((t) => new Date(t).toISOString()),
    unit,
    resolution: period,
    series: out,
    othersFolded,
    clamped: false,
  };
}

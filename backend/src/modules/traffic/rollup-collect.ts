/**
 * The traffic rollup's collector: every graph's series, written to the
 * platform database an hour at a time.
 *
 * It asks the same frames the panels ask — the same queries, the same names,
 * the same keys — for each view's full breakdown, one direction at a time,
 * and turns each series' points into what that hour moved. So a chart past
 * the metrics store's 30 days draws what it would have drawn then, summed per
 * day or month.
 *
 * It works through time from a watermark, up to two days of history per
 * pass, so its first runs backfill the 30 days the metrics store still holds
 * (about fifteen passes) and an outage is caught up rather than skipped.
 *
 * Each view is measured on its own. A view the store cannot answer for a span
 * is not recorded as measured, so it stays a gap there while the others are
 * kept; only when no view answers at all (the store is down) is the span left
 * for the next pass.
 */

import { isNotNull } from 'drizzle-orm';
import type { TrafficFrame, TrafficMetric, TrafficScope } from '@insula/api-contracts';
import { tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import type { VmClientOptions } from '../monitoring/vm-client.js';
import { UnsupportedTrafficQuery } from './promql.js';
import {
  fetchTrafficFrame, fineRetentionStart, subjectIdOf, type FrameOptions, type TrafficRequest, type TrafficServiceDeps,
} from './service.js';
import type { LiveRouteSource } from './live-ingress-routes.js';
import type { WarnLogger } from './route-naming.js';
import {
  readRollupWatermark, writeRollupHours, writeRollupWatermark,
  type RollupCoveredHour, type RollupHourValue, type RollupSeriesHours, type RollupSeriesIdentity,
} from './rollup-store.js';

const HOUR_MS = 3_600_000;
const SPAN_MS = 24 * HOUR_MS;
/** Hours are collected once they ended this long ago, so the store has every sample of them. */
const SETTLE_MS = 5 * 60_000;
/** A pass collects at most this many spans: the first runs backfill a month in a few hours, not at once. */
const SPANS_PER_PASS = 2;
/** …and starts no new span after this long, so a slow store cannot hold the lease for ever. */
const PASS_BUDGET_MS = 5 * 60_000;

/** One frame the collector asks for: a view's full breakdown, in one direction. */
export interface RollupAsk {
  readonly scope: TrafficScope;
  readonly metric: TrafficMetric;
  readonly direction: 'in' | 'out';
  /** Pod views are per tenant: the namespace whose pods are broken down. */
  readonly subject?: string;
}

const DIRECTIONS = ['out', 'in'] as const;

/**
 * Every frame an hour is collected from. Requests come before latency in each
 * view, because a latency mean is weighted by the requests behind it.
 *
 * A tenant's traffic is not among them: past 30 days it is drawn from the
 * bandwidth meter's billed egress, which already keeps it.
 */
export function rollupAsks(tenantNamespaces: readonly string[]): RollupAsk[] {
  const asks: RollupAsk[] = [];
  for (const scope of ['cluster', 'node', 'tenant', 'route'] as const) {
    if (scope !== 'tenant') for (const direction of DIRECTIONS) asks.push({ scope, metric: 'traffic', direction });
    asks.push({ scope, metric: 'requests', direction: 'out' }, { scope, metric: 'latency', direction: 'out' });
  }
  for (const ns of tenantNamespaces) {
    for (const direction of DIRECTIONS) asks.push({ scope: 'pod', metric: 'traffic', direction, subject: ns });
  }
  return asks;
}

/**
 * What one frame's series moved in each hour after `fromMs`.
 *
 * A point at `t` is the rate over the step ending at `t`, so it belongs to
 * the hour that contains the instant just before it, and the point AT `fromMs`
 * belongs to the span before. Bytes and requests are rate × step summed over
 * the hour; latency is the mean of the hour's measured points.
 */
export function hourlyValues(
  frame: TrafficFrame, fromMs: number, metric: TrafficMetric,
): Map<string, Map<number, { sum: number; n: number }>> {
  const out = new Map<string, Map<number, { sum: number; n: number }>>();
  const times = frame.times.map((t) => Date.parse(t));
  for (const s of frame.series) {
    const hours = new Map<number, { sum: number; n: number }>();
    s.points.forEach((v, i) => {
      const t = times[i];
      if (v === null || !Number.isFinite(v) || t <= fromMs) return;
      const hour = Math.floor((t - 1) / HOUR_MS) * HOUR_MS;
      const seen = hours.get(hour) ?? { sum: 0, n: 0 };
      hours.set(hour, { sum: seen.sum + (metric === 'latency' ? v : v * frame.stepSeconds), n: seen.n + 1 });
    });
    out.set(s.key, hours);
  }
  return out;
}

/** The hours any series of the frame has a measured point in. */
export function measuredHours(frame: TrafficFrame, fromMs: number): Set<number> {
  const out = new Set<number>();
  frame.times.forEach((iso, i) => {
    const t = Date.parse(iso);
    if (t <= fromMs) return;
    if (frame.series.some((s) => s.points[i] !== null && Number.isFinite(s.points[i]))) {
      out.add(Math.floor((t - 1) / HOUR_MS) * HOUR_MS);
    }
  });
  return out;
}

/** How a frame's series is stored: its identity in the rollup. */
export function identityFor(ask: RollupAsk, series: TrafficFrame['series'][number]): RollupSeriesIdentity {
  const base = { scope: ask.scope, metric: ask.metric, direction: ask.direction, kind: series.kind, grp: series.group ?? null };
  if (ask.scope === 'cluster') {
    return { ...base, seriesKey: series.key, subject: null, namespace: null, ref: null, name: series.name };
  }
  if (ask.scope === 'pod') {
    // Pods are folded per application by name, and the live frame keys the
    // folded row by that name. Within its tenant the application is what
    // stays the same across rollouts.
    const ns = ask.subject ?? '';
    return {
      ...base, seriesKey: `${ask.direction}:${ns}/${series.name}`, subject: series.name, namespace: ns,
      ref: subjectIdOf(series.key), name: series.name,
    };
  }
  const subject = subjectIdOf(series.key);
  return { ...base, seriesKey: `${ask.direction}:${subject}`, subject, namespace: null, ref: subject, name: series.name };
}

export interface CollectDeps extends Pick<TrafficServiceDeps, 'vm' | 'liveRoutes' | 'log'> {
  readonly db: Database;
  readonly now?: () => Date;
  /** The frame source; the real one unless a test supplies its own. */
  readonly fetchFrame?: (req: TrafficRequest, deps: TrafficServiceDeps, opts: FrameOptions) => Promise<TrafficFrame>;
}

/** The hours one series moved something in (bytes, requests), or was measured in (latency). */
function seriesHours(
  ask: RollupAsk, raw: ReadonlyMap<number, { sum: number; n: number }>, weights: ReadonlyMap<number, number> | undefined,
): Map<number, RollupHourValue> {
  const hours = new Map<number, RollupHourValue>();
  for (const [hour, { sum, n }] of raw) {
    if (ask.metric === 'latency') {
      const weight = weights?.get(hour) ?? null;
      if (n > 0) hours.set(hour, { value: sum / n, weight: weight && weight > 0 ? weight : null });
    } else if (sum > 0) {
      // A quiet hour is stored as no row: coverage says it was measured.
      hours.set(hour, { value: sum, weight: null });
    }
  }
  return hours;
}

/**
 * Collect the span (fromMs, toMs] and write it. Returns how many views
 * answered; throws only when none did, so the span is collected again.
 */
export async function collectSpan(deps: CollectDeps, fromMs: number, toMs: number): Promise<number> {
  const fetchFrame = deps.fetchFrame ?? fetchTrafficFrame;
  const namespaces = (await deps.db.select({ ns: tenants.kubernetesNamespace }).from(tenants)
    .where(isNotNull(tenants.kubernetesNamespace)))
    .map((r) => r.ns).filter((n): n is string => Boolean(n));

  const bySeries = new Map<string, RollupSeriesHours>();
  const covered: RollupCoveredHour[] = [];
  // Requests per hour by `${scope}|${seriesKey}`, to weight that series' latency.
  const requestsBy = new Map<string, Map<number, number>>();
  let answered = 0;
  let firstError: unknown = null;

  for (const ask of rollupAsks(namespaces)) {
    let frame: TrafficFrame;
    try {
      frame = await fetchFrame({
        from: new Date(fromMs), to: new Date(toMs), scope: ask.scope, subject: ask.subject,
        metric: ask.metric, direction: ask.direction, backups: ask.scope === 'cluster' ? 'separate' : 'included',
      }, { db: deps.db, vm: deps.vm, liveRoutes: deps.liveRoutes, log: deps.log }, { noFold: true });
    } catch (err) {
      // A measurement the store does not have (requests per node, where
      // Traefik carries no node label) is simply not kept.
      if (err instanceof UnsupportedTrafficQuery) continue;
      // Any other failure costs this view this span — a gap — and nothing else.
      firstError ??= err;
      deps.log?.warn({ err, scope: ask.scope, metric: ask.metric, subject: ask.subject }, 'traffic-rollup: a view could not be collected; it stays a gap for this span');
      continue;
    }
    answered += 1;
    const view = { scope: ask.scope, metric: ask.metric, direction: ask.direction, namespace: ask.scope === 'pod' ? ask.subject ?? '' : '' };
    for (const hour of measuredHours(frame, fromMs)) covered.push({ ...view, hour });
    const values = hourlyValues(frame, fromMs, ask.metric);
    for (const s of frame.series) {
      const identity = identityFor(ask, s);
      const id = `${identity.scope}|${identity.metric}|${identity.seriesKey}`;
      const hours = seriesHours(ask, values.get(s.key) ?? new Map(), requestsBy.get(`${ask.scope}|${identity.seriesKey}`));
      if (ask.metric === 'requests') {
        requestsBy.set(`${ask.scope}|${identity.seriesKey}`, new Map([...hours].map(([h, v]) => [h, v.value])));
      }
      // Two rows of one frame never share a key today; if they ever do, an
      // upsert batch would refuse the pair, so they are added together here.
      const seen = bySeries.get(id);
      if (seen && ask.metric !== 'latency') {
        const merged = new Map(seen.hours);
        for (const [h, v] of hours) merged.set(h, { value: (merged.get(h)?.value ?? 0) + v.value, weight: null });
        bySeries.set(id, { identity, hours: merged });
      } else if (!seen) {
        bySeries.set(id, { identity, hours });
      }
    }
  }
  if (answered === 0 && firstError !== null) throw firstError;
  await writeRollupHours(deps.db, [...bySeries.values()], covered);
  return answered;
}

/**
 * One pass: collect from the watermark up to the last settled hour, a day at
 * a time, at most `SPANS_PER_PASS` days and no new day after the budget. A
 * watermark older than what the metrics store still holds starts again at its
 * oldest hour.
 */
export async function collectTrafficRollup(deps: CollectDeps): Promise<{ spans: number; through: number | null }> {
  const clock = deps.now ?? (() => new Date());
  const started = Date.now();
  const now = clock().getTime();
  const settled = Math.floor((now - SETTLE_MS) / HOUR_MS) * HOUR_MS;
  const oldest = Math.ceil(fineRetentionStart(new Date(now)).getTime() / HOUR_MS) * HOUR_MS + HOUR_MS;
  const stored = await readRollupWatermark(deps.db);
  let through = stored === null || stored < oldest ? oldest : stored;
  let spans = 0;
  while (through < settled && spans < SPANS_PER_PASS && Date.now() - started < PASS_BUDGET_MS) {
    const end = Math.min(through + SPAN_MS, settled);
    await collectSpan(deps, through, end);
    await writeRollupWatermark(deps.db, end);
    through = end;
    spans += 1;
  }
  return { spans, through };
}

export interface RollupSchedulerOptions {
  readonly vm?: VmClientOptions;
  readonly liveRoutes?: LiveRouteSource;
  readonly log?: WarnLogger & { info?(obj: unknown, msg?: string): void };
  readonly intervalMs?: number;
}

/**
 * Start the collector: every 10 minutes, on one replica (a lease), so a
 * backfill works through two days per pass and an ordinary pass finds one
 * new hour. Returns a stop function for onClose.
 */
export function startTrafficRollup(db: Database, opts: RollupSchedulerOptions = {}): () => void {
  const intervalMs = opts.intervalMs ?? 10 * 60_000;
  const runOnce = (): void => {
    withSchedulerLease(db, 'traffic-rollup', intervalMs * 3, async () => {
      const r = await collectTrafficRollup({ db, vm: opts.vm, liveRoutes: opts.liveRoutes, log: opts.log });
      if (r.spans > 0) opts.log?.info?.({ spans: r.spans, through: r.through && new Date(r.through).toISOString() }, 'traffic-rollup: collected');
      return r;
    }).catch((err: unknown) => {
      opts.log?.warn({ err }, 'traffic-rollup: pass failed; the next pass collects the same hours');
    });
  };
  const bootKick = setTimeout(runOnce, 120_000);
  bootKick.unref?.();
  const timer = setInterval(runOnce, intervalMs);
  timer.unref?.();
  return () => {
    clearTimeout(bootKick);
    clearInterval(timer);
  };
}

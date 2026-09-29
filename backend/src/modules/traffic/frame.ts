/**
 * Turning raw range-query results into a frame the chart can draw.
 *
 * Pure functions only — no clients, no database — so the arithmetic that
 * decides what an operator sees is testable without a cluster.
 */

import {
  TRAFFIC_MAX_POINTS, TRAFFIC_TOP_N,
  type TrafficSeries, type TrafficUnit,
} from '@insula/api-contracts';
import type { VmRangeSeries } from '../monitoring/vm-client.js';

/** Step choices, coarsest last. A frame picks the finest that fits the cap. */
const STEP_LADDER_SECONDS = [60, 300, 900, 1800, 3600, 10800, 21600, 43200, 86400];

/**
 * Seconds per point for a range: the finest step that keeps the frame under
 * `TRAFFIC_MAX_POINTS`. Stepping off a ladder rather than dividing keeps
 * bucket edges on round clock boundaries, so two charts of the same window
 * line up instead of being a few seconds out of phase.
 */
export function chooseStepSeconds(fromMs: number, toMs: number): number {
  const span = Math.max(1, Math.round((toMs - fromMs) / 1000));
  for (const step of STEP_LADDER_SECONDS) {
    if (span / step <= TRAFFIC_MAX_POINTS) return step;
  }
  return STEP_LADDER_SECONDS[STEP_LADDER_SECONDS.length - 1];
}

/** Evenly spaced instants covering [from, to] at `stepSeconds`. */
export function buildTimeline(fromMs: number, toMs: number, stepSeconds: number): number[] {
  const stepMs = stepSeconds * 1000;
  // Align to the step so buckets sit on clock boundaries.
  const start = Math.ceil(fromMs / stepMs) * stepMs;
  const out: number[] = [];
  for (let t = start; t <= toMs && out.length <= TRAFFIC_MAX_POINTS; t += stepMs) out.push(t);
  return out;
}

/**
 * Project a VictoriaMetrics series onto the frame's timeline.
 *
 * A timestamp with no sample becomes `null`, never 0. VictoriaMetrics returns
 * nothing for a window it has no data for — a pod that did not exist yet, a
 * scrape that failed — and writing that as zero draws a confident line along
 * the axis, which reads as "nothing happened" rather than "nothing is known".
 *
 * Each SAMPLE is assigned to its nearest bucket, rather than each bucket
 * hunting for a sample. Hunting needs a search window, and any window wide
 * enough to catch a sample that drifted is wide enough for two neighbouring
 * buckets to catch the same one — which double-counted it in the totals.
 * Narrowing the window on one side fixed that and introduced the opposite
 * fault: a sample at the far edge of the LAST bucket, or anywhere at all when
 * the step is odd, had no neighbour to catch it and was dropped.
 *
 * Assignment has neither failure. Every sample lands in exactly one bucket or
 * none, no bucket depends on having a neighbour, and odd steps need no
 * special case. Where two samples claim one bucket the closer one wins, so
 * the result does not depend on the order VictoriaMetrics returned them in.
 */
export function alignToTimeline(
  points: ReadonlyArray<readonly [number, number]>,
  timeline: readonly number[],
  stepSeconds: number,
): Array<number | null> {
  const out: Array<number | null> = timeline.map(() => null);
  if (timeline.length === 0 || stepSeconds <= 0) return out;

  const originSec = timeline[0] / 1000;
  const tolerance = Math.max(1, stepSeconds / 2);
  const bestDrift: number[] = timeline.map(() => Number.POSITIVE_INFINITY);

  for (const [t, v] of points) {
    if (!Number.isFinite(v)) continue;
    const idx = Math.round((t - originSec) / stepSeconds);
    if (idx < 0 || idx >= timeline.length) continue;
    const drift = Math.abs(t - (originSec + idx * stepSeconds));
    // `<=` keeps an exact hit winning over nothing; strict `<` between two
    // candidates keeps the first of an exact tie, which only happens when two
    // samples sit equidistant either side of one bucket.
    if (drift > tolerance || drift >= bestDrift[idx]) continue;
    bestDrift[idx] = drift;
    out[idx] = v;
  }
  return out;
}

/** Sum of a series over the frame, in the metric's base unit × seconds. */
export function integrate(points: ReadonlyArray<number | null>, stepSeconds: number): number {
  let total = 0;
  for (const v of points) if (v !== null && Number.isFinite(v)) total += v * stepSeconds;
  return total;
}

/** Mean of the measured points, ignoring gaps. Null when nothing was measured. */
export function meanOf(points: ReadonlyArray<number | null>): number | null {
  let sum = 0; let n = 0;
  for (const v of points) if (v !== null && Number.isFinite(v)) { sum += v; n += 1; }
  return n === 0 ? null : sum / n;
}

/**
 * Rank by what the chart is actually showing: a total for rates, a mean for
 * latency. Ranking a latency chart by total would put the busiest service on
 * top rather than the slowest, which is the opposite of the question asked.
 */
export function rankValue(points: ReadonlyArray<number | null>, unit: TrafficUnit, stepSeconds: number): number {
  return unit === 'milliseconds' ? (meanOf(points) ?? 0) : integrate(points, stepSeconds);
}

export interface FoldResult {
  readonly series: TrafficSeries[];
  readonly othersFolded: number;
}

/**
 * Keep the biggest `TRAFFIC_TOP_N` and fold the tail into one `Other` row.
 *
 * Latency is never folded: averaging the tail's averages would invent a number
 * that belongs to nobody, and "the other 30 services averaged 91 ms" is not a
 * fact about any service. The tail is dropped and counted instead, so the UI
 * can say how many are not shown.
 */
export function foldTail(
  ranked: ReadonlyArray<{ key: string; name: string; points: Array<number | null> }>,
  unit: TrafficUnit,
  stepSeconds: number,
): FoldResult {
  const sorted = [...ranked].sort((a, b) => rankValue(b.points, unit, stepSeconds) - rankValue(a.points, unit, stepSeconds));
  const head = sorted.slice(0, TRAFFIC_TOP_N);
  const tail = sorted.slice(TRAFFIC_TOP_N);
  const series: TrafficSeries[] = head.map((s) => ({ key: s.key, name: s.name, kind: 'subject', points: s.points }));

  if (tail.length > 0 && unit !== 'milliseconds') {
    const length = head[0]?.points.length ?? tail[0].points.length;
    const summed: Array<number | null> = [];
    for (let i = 0; i < length; i++) {
      let acc: number | null = null;
      for (const s of tail) {
        const v = s.points[i];
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        acc = (acc ?? 0) + v;
      }
      summed.push(acc);
    }
    series.push({ key: '__other__', name: `Other (${tail.length})`, kind: 'other', points: summed });
  }
  return { series, othersFolded: tail.length };
}

/** Pick the identifying label value from a VM result's label set. */
export function seriesKey(s: VmRangeSeries, groupBy: string | null, fallback: string): string {
  if (!groupBy) return fallback;
  return s.labels[groupBy] ?? fallback;
}

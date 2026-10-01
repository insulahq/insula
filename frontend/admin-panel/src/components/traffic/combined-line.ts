/**
 * The one combined line a traffic view's stat tiles and spike markers read.
 *
 * Both used to add up every shown series, which was wrong twice over:
 *
 *  • On the cluster view, `Node-to-node` is a SUBSET of the wire total — the
 *    encapsulation rides over the NIC — so adding it counted those bytes
 *    twice in Total and Peak.
 *  • On a latency breakdown, adding averages made four 50 ms services read as
 *    a 200 ms one.
 *
 * The tiles and the chart's markers both come from here, so "3 spikes
 * flagged" always means the three markers on screen.
 */

import type { TrafficFrame, TrafficSeries } from '@insula/api-contracts';
import { findSpikes } from '@/components/charts/chart-scale';

/**
 * The shown series that may be combined into one figure.
 *
 * A grouped frame carries more than one MEASUREMENT. The wire is the ground
 * truth and its subsets are already inside it, so only the wire counts while
 * it is shown. With it hidden, the reader is asking what the rest looks like
 * on its own — one measurement, never two blended.
 */
export function combinableSeries(frame: TrafficFrame, hidden: ReadonlySet<string>): TrafficSeries[] {
  const shown = frame.series.filter((s) => !hidden.has(s.key));
  const wire = shown.filter((s) => s.group === 'wire');
  if (wire.length > 0) return wire;
  const firstGroup = shown[0]?.group;
  return shown.filter((s) => s.group === firstGroup);
}

/** Per instant: the sum of the combinable series, or their mean for latency. */
export function combinedLine(frame: TrafficFrame, hidden: ReadonlySet<string>): Array<number | null> {
  const series = combinableSeries(frame, hidden);
  const averaged = frame.unit === 'milliseconds';
  return frame.times.map((_, i) => {
    const measured = series
      .map((s) => s.points[i])
      .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
    if (measured.length === 0) return null;
    const sum = measured.reduce((a, v) => a + v, 0);
    return averaged ? sum / measured.length : sum;
  });
}

export interface TrafficStats {
  readonly peak: number;
  readonly peakAt: string | undefined;
  /** Over MEASURED instants only: a scrape gap is not a stretch of zero. */
  readonly avg: number;
  /** Integrated over the frame. Meaningless for latency, and not shown for it. */
  readonly total: number;
  /** Indices the chart marks; the tile counts these same markers. */
  readonly spikes: readonly number[];
}

export function trafficStats(frame: TrafficFrame, hidden: ReadonlySet<string>): TrafficStats | null {
  if (frame.series.every((s) => hidden.has(s.key))) return null;
  const line = combinedLine(frame, hidden);
  const measured = line.filter((v): v is number => v !== null);
  const peak = measured.length ? Math.max(...measured) : 0;
  const sum = measured.reduce((a, v) => a + v, 0);
  return {
    peak,
    peakAt: measured.length ? frame.times[line.indexOf(peak)] : undefined,
    avg: measured.length ? sum / measured.length : 0,
    total: sum * frame.stepSeconds,
    spikes: findSpikes(line),
  };
}

/** The key the combined row and line use — never a real series key. */
export const TOTAL_KEY = '__total';

/** Latencies do not add up; their combined line is a mean. */
export function totalLabel(unit: TrafficFrame['unit']): string {
  return unit === 'milliseconds' ? 'Average' : 'Total';
}

export interface TotalState {
  /** The view has a combined row at all. */
  readonly offered: boolean;
  /** Enough rows are shown for it to mean anything. */
  readonly usable: boolean;
  /** It is on the chart now. */
  readonly drawn: boolean;
}

/**
 * Whether a view offers the combined line, and whether it is drawn.
 *
 * Only a breakdown across subjects has one — a cluster view's rows are the
 * wire and subsets of it, which do not add up. A single row has none, since
 * it would be that row again, and neither does a view with fewer than two
 * rows showing. It is off until the reader asks for it: `hidden` starts with
 * `TOTAL_KEY` in it.
 */
export function totalState(frame: TrafficFrame, hidden: ReadonlySet<string>, breakdown: boolean): TotalState {
  const offered = breakdown && frame.series.length >= 2;
  const usable = offered && frame.series.filter((s) => !hidden.has(s.key)).length >= 2;
  return { offered, usable, drawn: usable && !hidden.has(TOTAL_KEY) };
}

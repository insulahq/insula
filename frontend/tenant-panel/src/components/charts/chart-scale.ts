/**
 * The arithmetic behind the charts, kept apart from the drawing so it can be
 * pinned by tests that do not need a DOM.
 *
 * Each of these was wrong on screen before it was here:
 *
 *  • Axis ticks. The axis used to split a "nice" ceiling into quarters, so a
 *    7.5×10^k ceiling put gridlines at 1.875, 3.75 and 5.625.
 *  • Paint order. A breakdown used to STACK its series — each line drawn at
 *    the running total of those below it — so every tenant above the biggest
 *    one wore its spikes. Lines are now drawn at their own values, lowest
 *    traffic first, so the highest ends up on top.
 *  • Sparkline thinning. Keeping every Nth point dropped short spikes, so the
 *    table's trend column and the chart above it disagreed about when things
 *    happened.
 */

/** Gridline steps, as multiples of a power of ten. */
const STEP_MULTIPLES = [1, 2, 2.5, 5, 10] as const;

/** Headroom so a peak that lands exactly on a tick does not touch the frame. */
const HEADROOM = 1.02;

export interface Ticks {
  /** From 0 to `ceiling` inclusive, evenly spaced on a 1/2/2.5/5 step. */
  readonly ticks: readonly number[];
  readonly ceiling: number;
}

/**
 * Axis ticks on 1 / 2 / 2.5 / 5 × 10^k steps, so every gridline lands on a
 * number a person would write down.
 *
 * `target` is roughly how many intervals the axis should have; short plots ask
 * for fewer so the labels do not collide.
 */
export function niceTicks(max: number, target = 4): Ticks {
  if (!Number.isFinite(max) || max <= 0) return { ticks: [0, 1], ceiling: 1 };
  const padded = max * HEADROOM;
  const want = Math.max(1, target);
  // A tall plot has room for one interval more than asked; a short one does not.
  const most = want >= 4 ? want + 1 : want;
  const exp = Math.floor(Math.log10(padded / want));
  const candidates = [exp - 1, exp, exp + 1]
    .flatMap((e) => STEP_MULTIPLES.map((m) => m * 10 ** e))
    .map((step) => ({ step, count: Math.ceil(padded / step - 1e-9) }))
    .filter((c) => c.count >= 1 && c.count <= most);
  // The LOWEST ceiling wins — the smallest step that merely fits can put a
  // 434 kB/s peak on a 600 kB/s axis, a third of the plot empty. Among equal
  // ceilings, the interval count nearest the target.
  const best = candidates.reduce<{ step: number; count: number } | null>((a, c) => {
    if (a === null) return c;
    const ca = a.step * a.count;
    const cc = c.step * c.count;
    if (Math.abs(cc - ca) > ca * 1e-9) return cc < ca ? c : a;
    return Math.abs(c.count - want) < Math.abs(a.count - want) ? c : a;
  }, null) ?? { step: 10 ** Math.ceil(Math.log10(padded)), count: 1 };
  // Multiply rather than accumulate, and trim the float noise either way:
  // 0.1 + 0.2 must be labelled 0.3.
  const ticks = Array.from({ length: best.count + 1 }, (_, i) => Number((i * best.step).toPrecision(12)));
  return { ticks, ceiling: ticks[ticks.length - 1] };
}

/** Sum of the measured points — the volume a series is ranked by. */
export function volumeOf(points: ReadonlyArray<number | null>): number {
  return points.reduce<number>((a, v) => (v === null || !Number.isFinite(v) ? a : a + v), 0);
}

export interface PaintInput {
  readonly key: string;
  readonly points: ReadonlyArray<number | null>;
  /** A total is context for the rest and is painted over all of them. */
  readonly emphasis?: 'total';
}

/**
 * The order to paint series in, as keys: lowest traffic first, so the highest
 * ends up on top; then the total; then the series the reader is focused on,
 * which must never be hidden under another line.
 */
export function paintOrder(series: readonly PaintInput[], focusKey: string | null): string[] {
  const ranked = series
    .map((s, i) => ({ s, i, volume: volumeOf(s.points) }))
    .sort((a, b) => {
      const tier = (x: PaintInput): number => (x.key === focusKey ? 2 : x.emphasis === 'total' ? 1 : 0);
      return (tier(a.s) - tier(b.s)) || (a.volume - b.volume) || (a.i - b.i);
    });
  return ranked.map((r) => r.s.key);
}

/** Runs of consecutive measured indices — each is one segment of a line. */
export function measuredRuns(points: ReadonlyArray<number | null>): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  points.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push(i);
  });
  if (run.length) runs.push(run);
  return runs;
}

export interface DecimatedPoint {
  /** Index into the original series, so x stays at the right instant. */
  readonly i: number;
  /** `null` marks a gap: a bucket with no measurement at all. */
  readonly v: number | null;
}

/**
 * Thin a series to about `buckets × 2` points without losing its extremes.
 *
 * Each bucket keeps its lowest and highest measured point, in time order.
 * Sampling every Nth point instead drops any spike shorter than N steps —
 * which is most of them.
 */
export function decimateMinMax(
  points: ReadonlyArray<number | null>,
  buckets: number,
): DecimatedPoint[] {
  if (points.length <= buckets * 2) {
    return points.map((v, i) => ({ i, v: v === null || !Number.isFinite(v) ? null : v }));
  }
  const size = points.length / buckets;
  const out: DecimatedPoint[] = [];
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * size);
    const end = Math.min(points.length, Math.floor((b + 1) * size));
    let lo: DecimatedPoint | null = null;
    let hi: DecimatedPoint | null = null;
    for (let i = start; i < end; i++) {
      const v = points[i];
      if (v === null || !Number.isFinite(v)) continue;
      if (lo === null || v < (lo.v as number)) lo = { i, v };
      if (hi === null || v > (hi.v as number)) hi = { i, v };
    }
    if (lo === null || hi === null) out.push({ i: start, v: null });
    else if (lo.i === hi.i) out.push(lo);
    else out.push(...(lo.i < hi.i ? [lo, hi] : [hi, lo]));
  }
  return out;
}

/** A point worth labelling: a local maximum well above the surrounding level. */
export function findSpikes(totals: ReadonlyArray<number | null>, max = 3): number[] {
  const measured = totals.map((v) => (v === null ? 0 : v));
  const n = measured.length;
  if (n < 8) return [];
  const mean = measured.reduce((a, v) => a + v, 0) / n;
  if (mean <= 0) return [];
  const spacing = Math.max(3, Math.round(n * 0.06));
  return measured
    .map((v, i) => ({ v, i }))
    .filter(({ v, i }) => i > 1 && i < n - 2 && v > mean * 2.4)
    .sort((a, b) => b.v - a.v)
    .reduce<number[]>((acc, { i }) => {
      if (acc.length >= max) return acc;
      if (acc.some((j) => Math.abs(j - i) < spacing)) return acc;
      return [...acc, i];
    }, [])
    .sort((a, b) => a - b);
}

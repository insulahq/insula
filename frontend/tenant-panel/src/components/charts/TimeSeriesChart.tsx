/**
 * A time-series chart, in no particular subsystem's terms.
 *
 * The traffic tabs were the first caller, and for a while the only one, so
 * the chart spoke `TrafficFrame` and formatted bytes. Nothing about drawing a
 * line over time is about traffic, and the SLO tab has been making do with a
 * 14-line sparkline that cannot show a gap, a second series, or a hover
 * reading. This is the shared one: callers hand over points and the two
 * functions that turn a number into words.
 *
 * What it owns, because every caller wants the same answers:
 *
 *  • A gap is a gap. `null` breaks the line rather than dropping it to zero —
 *    a scrape that did not happen is not a measurement of nothing. A single
 *    measured point between two gaps is drawn as a dot, since a run of one
 *    has no segment to belong to and dropping it hides a real reading.
 *  • The readout is PINNED and appears only while the pointer is on the plot.
 *    One that follows the cursor covers the peak you are reading; one that is
 *    always visible claims a reading nobody asked for.
 *  • Stacking is the caller's decision, per series. Series that are subsets
 *    of another must never be added into it.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';

/** Colour-blind-safe and legible on both grounds. */
export const CHART_COLOURS = [
  '#1a75ff', '#0f766e', '#b45309', '#7c3aed', '#be123c', '#0891b2', '#65a30d',
] as const;

export function colourForIndex(i: number): string {
  return CHART_COLOURS[i % CHART_COLOURS.length];
}

export interface ChartSeries {
  readonly key: string;
  readonly name: string;
  /** `null` means unmeasured, and is drawn as a gap. */
  readonly points: ReadonlyArray<number | null>;
  /** Defaults to the palette position. */
  readonly colour?: string;
  /**
   * Series sharing a group stack together when `stacked` is set. A series
   * with no group never stacks — which is how a subset of another series is
   * kept out of the total it already belongs to.
   */
  readonly stackGroup?: string;
}

export interface TimeSeriesChartProps {
  /** ISO-8601 instants, index-aligned to every series' points. */
  readonly times: readonly string[];
  readonly series: readonly ChartSeries[];
  /** Seconds between points — used for the "in this step" reading. */
  readonly stepSeconds: number;
  /** A value as an instantaneous reading: "1.19 MB/s", "42 ms". */
  readonly formatValue: (v: number | null) => string;
  /** A value accumulated over one step: "47.5 MB". Omit to hide that line. */
  readonly formatStepTotal?: (v: number | null, seconds: number) => string;
  /** An axis tick for an instant. */
  readonly formatTick: (iso: string, stepSeconds: number) => string;
  /** The full instant, for the readout heading. */
  readonly formatInstant: (iso: string) => string;
  readonly hidden?: ReadonlySet<string>;
  readonly stacked?: boolean;
  readonly height?: number;
  /** Rendered inside the plot, top-left, and hidden while the readout shows. */
  readonly cornerNote?: React.ReactNode;
  /** Rendered inside the plot, top-right. */
  readonly badge?: React.ReactNode;
  /** Called with the instant of a spike marker the reader clicked. */
  readonly onZoom?: (centreIso: string) => void;
  readonly ariaLabel?: string;
  readonly className?: string;
}

const M = { top: 18, right: 16, bottom: 26, left: 62 };

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
      acc.push(i);
      return acc;
    }, [])
    .sort((a, b) => a - b);
}

/** Nice round axis maximum, so gridlines land on readable numbers. */
export function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) if (value <= m * base) return m * base;
  return 10 * base;
}

interface Band {
  readonly key: string;
  readonly name: string;
  readonly colour: string;
  readonly upper: Array<number | null>;
  readonly own: ReadonlyArray<number | null>;
}

export default function TimeSeriesChart({
  times, series, stepSeconds, formatValue, formatStepTotal, formatTick, formatInstant,
  hidden, stacked = false, height = 260, cornerNote, badge, onZoom,
  ariaLabel = 'Values over time', className,
}: TimeSeriesChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => {
      setWidth(Math.max(360, Math.round(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visible = useMemo(
    () => series.filter((s) => !hidden?.has(s.key)),
    [series, hidden],
  );

  // Heavier than the mockup's 1.75. That value was read off a design file at
  // its own scale; on a real plot at real viewing distance the series still
  // read as hairlines against the gridlines, which was the operator's
  // complaint twice over. Daily-rollup points are further apart again and
  // get more weight still, with butt caps so a single day is a segment
  // rather than a round blob.
  const coarse = stepSeconds >= 86_400;

  const { bands, totals, ceiling } = useMemo(() => {
    const running = new Map<string, Array<number | null>>();
    const out: Band[] = [];
    visible.forEach((s, i) => {
      const upper: Array<number | null> = [];
      const group = stacked ? s.stackGroup : undefined;
      const acc = group ? running.get(group) ?? times.map(() => null) : null;
      for (let idx = 0; idx < times.length; idx++) {
        const v = s.points[idx] ?? null;
        if (!acc) { upper.push(v); continue; }
        if (v === null) { upper.push(acc[idx]); continue; }
        acc[idx] = (acc[idx] ?? 0) + v;
        upper.push(acc[idx]);
      }
      if (group && acc) running.set(group, acc);
      out.push({
        key: s.key,
        name: s.name,
        colour: s.colour ?? colourForIndex(i),
        upper,
        own: s.points,
      });
    });
    const tot: Array<number | null> = times.map((_, idx) => {
      let best: number | null = null;
      for (const b of out) {
        const v = b.upper[idx];
        if (v === null) continue;
        best = best === null ? v : Math.max(best, v);
      }
      return best;
    });
    const peak = tot.reduce<number>((a, v) => (v !== null && v > a ? v : a), 0);
    return { bands: out, totals: tot, ceiling: niceCeiling(peak * 1.08) };
  }, [visible, times, stacked]);

  const iw = Math.max(1, width - M.left - M.right);
  const ih = Math.max(1, height - M.top - M.bottom);
  const n = times.length;
  const x = useCallback((i: number) => M.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw), [n, iw]);
  const y = useCallback((v: number) => M.top + ih - (v / ceiling) * ih, [ih, ceiling]);

  const spikes = useMemo(() => findSpikes(totals), [totals]);

  const segmentsOf = useCallback((points: ReadonlyArray<number | null>) => {
    const lines: string[] = [];
    const dots: Array<{ cx: number; cy: number }> = [];
    let run: Array<{ i: number; v: number }> = [];
    const flush = (): void => {
      if (run.length > 1) lines.push(run.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' '));
      else if (run.length === 1) dots.push({ cx: x(run[0].i), cy: y(run[0].v) });
      run = [];
    };
    points.forEach((v, i) => {
      if (v === null) { flush(); return; }
      run.push({ i, v });
    });
    flush();
    return { lines, dots };
  }, [x, y]);

  const onMove = useCallback((ev: React.MouseEvent<SVGSVGElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * width;
    const py = ((ev.clientY - rect.top) / rect.height) * height;
    if (px < M.left || px > width - M.right || py < M.top - 8 || py > M.top + ih + 8) {
      setHoverIndex(null);
      return;
    }
    const i = Math.round(((px - M.left) / iw) * (n - 1));
    setHoverIndex(Math.max(0, Math.min(n - 1, i)));
  }, [width, height, iw, ih, n]);

  const gridValues = [0, 0.25, 0.5, 0.75, 1].map((f) => f * ceiling);
  const tickIndices = useMemo(() => {
    const want = Math.min(7, Math.max(2, Math.floor(iw / 130)));
    return Array.from({ length: want }, (_, k) => Math.round((k / (want - 1)) * (n - 1)));
  }, [iw, n]);

  const hovered = hoverIndex !== null ? times[hoverIndex] : null;
  const ranked = hoverIndex === null ? [] : bands
    .map((b) => ({ b, v: b.own[hoverIndex] ?? null }))
    .filter((r) => r.v !== null)
    .sort((a, b2) => (b2.v ?? 0) - (a.v ?? 0));
  const nearSpike = hoverIndex === null
    ? undefined
    : spikes.find((s) => Math.abs(s - hoverIndex) <= Math.max(1, Math.round(n * 0.012)));

  return (
    <div ref={wrapRef} className={clsx('relative w-full', className)}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={ariaLabel}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIndex(null)}
        className="block select-none"
      >
        <defs>
          <linearGradient id="chart-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1a75ff" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#1a75ff" stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {gridValues.map((v) => (
          <g key={v}>
            <line
              x1={M.left} x2={width - M.right} y1={y(v)} y2={y(v)}
              className="stroke-gray-200 dark:stroke-gray-700" strokeWidth={1}
            />
            <text
              x={M.left - 8} y={y(v) + 4} textAnchor="end"
              className="fill-gray-500 text-[10px] tabular-nums dark:fill-gray-400"
            >
              {formatValue(v)}
            </text>
          </g>
        ))}

        {stacked && bands.length > 0 && (
          <polygon
            points={`${totals.map((v, i) => `${x(i).toFixed(1)},${y(v ?? 0).toFixed(1)}`).join(' ')} ${x(n - 1)},${y(0)} ${x(0)},${y(0)}`}
            fill="url(#chart-area)"
          />
        )}

        {bands.map((b) => {
          const { lines, dots } = segmentsOf(b.upper);
          return (
            <g key={b.key}>
              {lines.map((pts, si) => (
                <polyline
                  key={`${b.key}-l${si}`} points={pts} fill="none" stroke={b.colour}
                  strokeWidth={coarse ? 3.2 : 2.6} strokeLinecap={coarse ? 'butt' : 'round'}
                  strokeLinejoin="round" vectorEffect="non-scaling-stroke"
                />
              ))}
              {dots.map((d, di) => (
                <circle key={`${b.key}-d${di}`} cx={d.cx} cy={d.cy} r={1.8} fill={b.colour} />
              ))}
            </g>
          );
        })}

        {spikes.map((i) => (
          <g key={`spike-${i}`}>
            <line
              x1={x(i)} x2={x(i)} y1={M.top} y2={y(totals[i] ?? 0) - 5}
              className="stroke-amber-500" strokeWidth={1} strokeDasharray="2 3"
            />
            <circle
              cx={x(i)} cy={M.top} r={4}
              className={clsx('fill-amber-500', onZoom && 'cursor-pointer')}
              onClick={() => onZoom?.(times[i])}
            >
              <title>{`Spike at ${formatInstant(times[i])}${onZoom ? ' — click to zoom' : ''}`}</title>
            </circle>
          </g>
        ))}

        {hoverIndex !== null && (
          <line
            x1={x(hoverIndex)} x2={x(hoverIndex)} y1={M.top} y2={M.top + ih}
            className="stroke-gray-400 dark:stroke-gray-500" strokeWidth={1} strokeDasharray="3 3"
          />
        )}
        {hoverIndex !== null && bands.map((b) => {
          const v = b.upper[hoverIndex];
          return v === null ? null : (
            <circle key={`dot-${b.key}`} cx={x(hoverIndex)} cy={y(v)} r={3.5} fill={b.colour} />
          );
        })}

        {tickIndices.map((i) => (
          <text
            key={`tick-${i}`} x={x(i)} y={height - 8}
            textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
            className="fill-gray-500 text-[10px] tabular-nums dark:fill-gray-400"
          >
            {times[i] ? formatTick(times[i], stepSeconds) : ''}
          </text>
        ))}
      </svg>

      {hovered && (
        <div
          className="pointer-events-none absolute left-[74px] top-[5px] z-10 min-w-[200px] rounded-lg
            border border-gray-200 bg-white/95 px-3 py-2 text-xs shadow-lg backdrop-blur
            dark:border-gray-700 dark:bg-gray-800/95"
          data-testid="chart-readout"
        >
          <div className="mb-1 font-medium tabular-nums text-gray-900 dark:text-gray-100">
            {formatInstant(hovered)}
          </div>
          {ranked.slice(0, 6).map(({ b, v }) => (
            <div key={b.key} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-gray-600 dark:text-gray-300">
                <i className="inline-block h-2 w-2 rounded-sm" style={{ background: b.colour }} />
                {b.name}
              </span>
              <span className="tabular-nums text-gray-900 dark:text-gray-100">{formatValue(v)}</span>
            </div>
          ))}
          {ranked.length > 6 && (
            <div className="text-gray-500 dark:text-gray-400">+ {ranked.length - 6} more</div>
          )}
          {stacked && formatStepTotal && (
            <div className="mt-1 flex items-center justify-between gap-4 border-t border-gray-200 pt-1 dark:border-gray-700">
              <span className="text-gray-600 dark:text-gray-300">In this step</span>
              <span className="font-medium tabular-nums text-gray-900 dark:text-gray-100">
                {formatStepTotal(totals[hoverIndex ?? 0], stepSeconds)}
              </span>
            </div>
          )}
          {nearSpike !== undefined && (
            <div className="mt-1 border-t border-gray-200 pt-1 text-amber-600 dark:border-gray-700 dark:text-amber-400">
              Spike
            </div>
          )}
        </div>
      )}

      {!hovered && cornerNote && (
        <div className="pointer-events-none absolute left-[74px] top-[5px]">{cornerNote}</div>
      )}
      {badge && <div className="pointer-events-none absolute right-4 top-[5px]">{badge}</div>}
    </div>
  );
}

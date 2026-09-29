/**
 * The traffic chart.
 *
 * Hand-rolled SVG, because the panels ship no charting library and adding one
 * for a single view would cost more bundle than the whole feature
 * (`SloTab.tsx` sets the same precedent).
 *
 * Two deliberate choices carry most of the design:
 *
 *  • The readout is PINNED to the top-left and appears only while the pointer
 *    is over the plot. A tooltip that chases the cursor covers the very peak
 *    you are trying to read, and one that is always visible claims a reading
 *    nobody asked for.
 *  • A gap is a gap. `null` points break the line instead of dropping it to
 *    zero, so an unscraped window looks unknown rather than quiet.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { TrafficFrame } from '@insula/api-contracts';
import {
  formatAxisTick, formatInstant, formatTrafficRate, formatTrafficTotal,
} from '@/lib/format-traffic';

const M = { top: 18, right: 16, bottom: 26, left: 62 };
const MIN_HEIGHT = 260;

/** Colour-blind-safe and legible on both grounds. */
export const TRAFFIC_COLOURS = [
  '#1a75ff', '#0f766e', '#b45309', '#7c3aed', '#be123c', '#0891b2', '#65a30d',
] as const;

export function colourForIndex(i: number): string {
  return TRAFFIC_COLOURS[i % TRAFFIC_COLOURS.length];
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
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (value <= m * base) return m * base;
  }
  return 10 * base;
}

export interface TrafficChartProps {
  readonly frame: TrafficFrame;
  /** Series keys the viewer has hidden by clicking a table row. */
  readonly hidden?: ReadonlySet<string>;
  /** Stack the series into a total, rather than overlaying them. */
  readonly stacked: boolean;
  /** Zoom to a window centred on a spike marker. */
  readonly onZoom?: (centreIso: string) => void;
  readonly className?: string;
}

interface Band {
  readonly key: string;
  readonly name: string;
  readonly colour: string;
  /** Upper edge at each index — the running total when stacked. */
  readonly upper: Array<number | null>;
  readonly own: ReadonlyArray<number | null>;
}

export default function TrafficChart({
  frame, hidden, stacked, onZoom, className,
}: TrafficChartProps) {
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
    () => frame.series.filter((s) => !hidden?.has(s.key)),
    [frame.series, hidden],
  );

  const { bands, totals, ceiling } = useMemo(() => {
    const running: Array<number | null> = frame.times.map(() => null);
    const out: Band[] = [];
    visible.forEach((s, i) => {
      const upper: Array<number | null> = [];
      for (let idx = 0; idx < frame.times.length; idx++) {
        const v = s.points[idx] ?? null;
        if (!stacked) { upper.push(v); continue; }
        if (v === null) { upper.push(running[idx]); continue; }
        running[idx] = (running[idx] ?? 0) + v;
        upper.push(running[idx]);
      }
      out.push({ key: s.key, name: s.name, colour: colourForIndex(i), upper, own: s.points });
    });
    const tot: Array<number | null> = frame.times.map((_, idx) => {
      if (stacked) return running[idx];
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
  }, [visible, frame.times, stacked]);

  const height = MIN_HEIGHT;
  const iw = Math.max(1, width - M.left - M.right);
  const ih = Math.max(1, height - M.top - M.bottom);
  const n = frame.times.length;
  const x = useCallback((i: number) => M.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw), [n, iw]);
  const y = useCallback((v: number) => M.top + ih - (v / ceiling) * ih, [ih, ceiling]);

  const spikes = useMemo(() => findSpikes(totals), [totals]);

  /**
   * Split a series at its gaps so the line breaks instead of bridging them.
   * A single polyline across a null would draw a straight segment over the
   * missing hours, which is a claim that traffic was interpolated-flat.
   */
  const segmentsOf = useCallback((points: ReadonlyArray<number | null>): {
    lines: string[]; dots: Array<{ cx: number; cy: number }>;
  } => {
    const lines: string[] = [];
    const dots: Array<{ cx: number; cy: number }> = [];
    let run: Array<{ i: number; v: number }> = [];
    const flush = (): void => {
      if (run.length > 1) lines.push(run.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' '));
      // A single measured point between two gaps has no segment to be part
      // of. Dropping it would hide a real measurement — the same failure as
      // drawing a gap as zero, in the other direction — so it gets a dot.
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
    const svg = ev.currentTarget;
    const rect = svg.getBoundingClientRect();
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

  const hovered = hoverIndex !== null ? frame.times[hoverIndex] : null;
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
        aria-label="Traffic over time"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIndex(null)}
        className="block select-none"
      >
        <defs>
          <linearGradient id="traffic-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="[stop-color:theme(colors.blue.500)]" stopOpacity="0.20" />
            <stop offset="100%" className="[stop-color:theme(colors.blue.500)]" stopOpacity="0.01" />
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
              className="fill-gray-500 dark:fill-gray-400 text-[10px] tabular-nums"
            >
              {formatTrafficRate(v, frame.unit)}
            </text>
          </g>
        ))}

        {stacked && bands.length > 0 && (
          <polygon
            points={`${totals.map((v, i) => `${x(i).toFixed(1)},${y(v ?? 0).toFixed(1)}`).join(' ')} ${x(n - 1)},${y(0)} ${x(0)},${y(0)}`}
            fill="url(#traffic-area)"
          />
        )}

        {bands.map((b) => {
          const { lines, dots } = segmentsOf(b.upper);
          return (
            <g key={b.key}>
              {lines.map((pts, si) => (
                <polyline
                  key={`${b.key}-l${si}`} points={pts} fill="none" stroke={b.colour}
                  strokeWidth={1.6} strokeLinejoin="round" vectorEffect="non-scaling-stroke"
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
              className="fill-amber-500 cursor-pointer"
              onClick={() => onZoom?.(frame.times[i])}
            >
              <title>{`Spike at ${formatInstant(frame.times[i])}${onZoom ? ' — click to zoom' : ''}`}</title>
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
            className="fill-gray-500 dark:fill-gray-400 text-[10px] tabular-nums"
          >
            {frame.times[i] ? formatAxisTick(frame.times[i], frame.stepSeconds) : ''}
          </text>
        ))}
      </svg>

      {/* Pinned, and only while the pointer is actually on the plot. */}
      {hovered && (
        <div
          className="pointer-events-none absolute left-[74px] top-[5px] z-10 min-w-[200px] rounded-lg border
            border-gray-200 bg-white/95 px-3 py-2 text-xs shadow-lg backdrop-blur
            dark:border-gray-700 dark:bg-gray-800/95"
          data-testid="traffic-readout"
        >
          <div className="mb-1 font-medium text-gray-900 tabular-nums dark:text-gray-100">
            {formatInstant(hovered)}
          </div>
          {ranked.slice(0, 5).map(({ b, v }) => (
            <div key={b.key} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-gray-600 dark:text-gray-300">
                <i className="inline-block h-2 w-2 rounded-sm" style={{ background: b.colour }} />
                {b.name}
              </span>
              <span className="tabular-nums text-gray-900 dark:text-gray-100">
                {formatTrafficRate(v, frame.unit)}
              </span>
            </div>
          ))}
          {ranked.length > 5 && (
            <div className="text-gray-500 dark:text-gray-400">+ {ranked.length - 5} more</div>
          )}
          {stacked && (
            <div className="mt-1 flex items-center justify-between gap-4 border-t border-gray-200 pt-1 dark:border-gray-700">
              <span className="text-gray-600 dark:text-gray-300">In this step</span>
              <span className="tabular-nums font-medium text-gray-900 dark:text-gray-100">
                {formatTrafficTotal(totals[hoverIndex ?? 0], frame.unit, frame.stepSeconds)}
              </span>
            </div>
          )}
          {nearSpike !== undefined && (
            <div className="mt-1 border-t border-gray-200 pt-1 text-amber-600 dark:border-gray-700 dark:text-amber-400">
              Traffic spike
            </div>
          )}
        </div>
      )}

      <div className="pointer-events-none absolute right-4 top-[5px] rounded-full border border-gray-200
        bg-white/90 px-2 py-0.5 text-[10px] text-gray-500 tabular-nums dark:border-gray-700
        dark:bg-gray-800/90 dark:text-gray-400">
        {stepLabel(frame.stepSeconds)} · {n} points
      </div>
    </div>
  );
}

export function stepLabel(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}-day steps`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}-hour steps`;
  return `${Math.round(seconds / 60)}-minute steps`;
}

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
 *  • Every series is drawn at ITS OWN value. Nothing stacks: a stacked line
 *    reads as the series itself, so every line above the biggest subject wore
 *    that subject's spikes. A caller that wants the sum passes it as a series
 *    with `emphasis: 'total'`.
 *  • Paint order follows traffic: the lowest volume first, the highest on
 *    top, the total over all of them, the focused series over everything.
 *  • The readout appears only while the pointer is on the plot, and sits on
 *    the side AWAY from the pointer, so it never covers the instant being read.
 *  • Dragging across the plot selects a range; spike markers zoom on click.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { findSpikes, measuredRuns, niceTicks, paintOrder } from './chart-scale';

/** Colour-blind-safe and legible on both grounds. */
export const CHART_COLOURS = [
  '#1a75ff', '#0f766e', '#b45309', '#7c3aed', '#be123c', '#0891b2', '#65a30d',
] as const;

export function colourForIndex(i: number): string {
  return CHART_COLOURS[i % CHART_COLOURS.length];
}

/**
 * The total's grey, per theme. A literal class list so Tailwind keeps it, and
 * shared so the table's chip and the line can never drift apart.
 */
export const TOTAL_STROKE = 'stroke-[#7b8494] dark:stroke-[#8b95a6]';
export const TOTAL_FILL = 'fill-[#7b8494] dark:fill-[#8b95a6]';
export const TOTAL_BG = 'bg-[#7b8494] dark:bg-[#8b95a6]';

export interface ChartSeries {
  readonly key: string;
  readonly name: string;
  /** `null` means unmeasured, and is drawn as a gap. */
  readonly points: ReadonlyArray<number | null>;
  /** Defaults to the palette position. Ignored for a total. */
  readonly colour?: string;
  /** A total: drawn grey with an area under it, over every other series. */
  readonly emphasis?: 'total';
}

export interface TimeSeriesChartProps {
  /** ISO-8601 instants, index-aligned to every series' points. */
  readonly times: readonly string[];
  readonly series: readonly ChartSeries[];
  /** Seconds between points — used for the "in this step" reading. */
  readonly stepSeconds: number;
  /** A value as an instantaneous reading: "1.19 MB/s", "42 ms". */
  readonly formatValue: (v: number | null) => string;
  /** The share base accumulated over one step: "47.5 MB". Omit to hide that line. */
  readonly formatStepTotal?: (v: number | null, seconds: number) => string;
  /** An axis tick for an instant. */
  readonly formatTick: (iso: string, stepSeconds: number) => string;
  /** The full instant, for the readout heading. */
  readonly formatInstant: (iso: string) => string;
  readonly hidden?: ReadonlySet<string>;
  /** The series to highlight; every other one fades. */
  readonly focusKey?: string | null;
  /**
   * Per instant, what each series' share is a share OF. Omit and the readout
   * shows values only. Independent of whether a total line is drawn.
   */
  readonly shareBase?: ReadonlyArray<number | null>;
  readonly height?: number;
  /**
   * Where to put spike markers. Omit to detect them on the highest drawn
   * value; a caller whose stat tiles count spikes passes its own, so the
   * tile and the markers can never disagree.
   */
  readonly spikeIndices?: readonly number[];
  /** Edge to edge: axis labels inside the plot, notes in a strip above it. */
  readonly fullBleed?: boolean;
  /** Top-left: inside the plot, or in the strip when `fullBleed`. */
  readonly cornerNote?: React.ReactNode;
  /** Top-right: inside the plot, or in the strip when `fullBleed`. */
  readonly badge?: React.ReactNode;
  /** Called with the instant of a spike marker the reader clicked. */
  readonly onZoom?: (centreIso: string) => void;
  /** Called with the first and last instant of a range dragged across the plot. */
  readonly onRangeSelect?: (fromIso: string, toIso: string) => void;
  readonly ariaLabel?: string;
  readonly className?: string;
}

const MARGIN = { top: 18, right: 16, bottom: 26, left: 62 };
// The top gridline's label is drawn ABOVE its line, inside the plot, so the
// top margin must hold one line of text — at 12 px it was clipped in half.
const MARGIN_BLEED = { top: 20, right: 8, bottom: 24, left: 8 };
/** A drag shorter than this is a click with a shaky hand. */
const MIN_DRAG_PX = 6;

interface Drawn extends ChartSeries {
  readonly colour: string;
}

function percent(part: number, whole: number | null): string {
  if (whole === null || whole <= 0) return '—';
  const p = (part / whole) * 100;
  return p >= 10 || p === 0 ? `${p.toFixed(0)}%` : `${p.toFixed(1)}%`;
}

export default function TimeSeriesChart({
  times, series, stepSeconds, formatValue, formatStepTotal, formatTick, formatInstant,
  hidden, focusKey: requestedFocus = null, shareBase, height = 260, spikeIndices, fullBleed = false,
  cornerNote, badge, onZoom, onRangeSelect, ariaLabel = 'Values over time', className,
}: TimeSeriesChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(900);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  // The drag lives in a ref, read by the window listeners; the state copy
  // only redraws the brush. Deciding in a state updater would run the zoom
  // twice under StrictMode, which calls updaters twice.
  const dragRef = useRef<{ a: number; b: number; x0: number } | null>(null);
  const [drag, setDrag] = useState<{ a: number; b: number; x0: number } | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => {
      setWidth(Math.max(360, Math.round(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const M = fullBleed ? MARGIN_BLEED : MARGIN;

  // Colour is assigned BEFORE hiding, by position in the full list: a series
  // keeps its colour when a neighbour is hidden, and still matches its row in
  // the table below.
  const visible: Drawn[] = useMemo(
    () => series
      .map((s, i) => ({ ...s, colour: s.colour ?? colourForIndex(i) }))
      .filter((s) => !hidden?.has(s.key)),
    [series, hidden],
  );
  // A key that matches nothing drawn is no focus at all. A refetch can drop
  // the hovered row — its table row unmounts under the pointer and never
  // fires mouseleave — and honouring the dead key faded every line at once.
  const focusKey = requestedFocus !== null && visible.some((s) => s.key === requestedFocus) ? requestedFocus : null;
  const order = useMemo(() => {
    const byKey = new Map(visible.map((s) => [s.key, s]));
    return paintOrder(visible, focusKey).map((k) => byKey.get(k) as Drawn);
  }, [visible, focusKey]);

  // Heavier than the mockup's 1.75 when there are few lines: on a real plot
  // at real viewing distance those read as hairlines, which was the
  // operator's complaint twice over. A breakdown has many lines crossing, and
  // there the same weight turns into a knot. Daily-rollup points are further
  // apart and get butt caps, so a single day is a segment, not a blob.
  const coarse = stepSeconds >= 86_400;
  const baseWidth = coarse ? 3.2 : visible.length > 2 ? 1.9 : 2.6;

  const { tops, ticks, ceiling } = useMemo(() => {
    const top: Array<number | null> = times.map((_, idx) => visible.reduce<number | null>((best, s) => {
      const v = s.points[idx];
      return v === null || v === undefined || !Number.isFinite(v) ? best : Math.max(best ?? v, v);
    }, null));
    const peak = top.reduce<number>((a, v) => (v !== null && v > a ? v : a), 0);
    const t = niceTicks(peak, height < 160 ? 2 : 4);
    return { tops: top, ticks: t.ticks, ceiling: t.ceiling };
  }, [visible, times, height]);

  const iw = Math.max(1, width - M.left - M.right);
  const ih = Math.max(1, height - M.top - M.bottom);
  const n = times.length;
  const x = useCallback((i: number) => M.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw), [M.left, n, iw]);
  const y = useCallback((v: number) => M.top + ih - (v / ceiling) * ih, [M.top, ih, ceiling]);
  const at = useCallback((i: number, v: number) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`, [x, y]);

  const spikes = useMemo(() => spikeIndices ?? findSpikes(tops), [spikeIndices, tops]);

  /** Pointer position → the index under it, or null outside the plot. */
  const locate = useCallback((clientX: number): { i: number; px: number } | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const px = ((clientX - rect.left) / rect.width) * width;
    const i = Math.round(((px - M.left) / iw) * (n - 1));
    return { i: Math.max(0, Math.min(n - 1, i)), px };
  }, [width, M.left, iw, n]);

  const onMove = useCallback((ev: React.MouseEvent<SVGSVGElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const py = ((ev.clientY - rect.top) / Math.max(1, rect.height)) * height;
    const hit = locate(ev.clientX);
    if (!hit || hit.px < M.left || hit.px > width - M.right || py < M.top - 8 || py > M.top + ih + 8) {
      setHoverIndex(null);
      return;
    }
    setHoverIndex(hit.i);
  }, [locate, height, width, M.left, M.right, M.top, ih]);

  const onDown = useCallback((ev: React.MouseEvent<SVGSVGElement>) => {
    if (!onRangeSelect || ev.button !== 0) return;
    const hit = locate(ev.clientX);
    if (!hit || hit.px < M.left || hit.px > width - M.right) return;
    ev.preventDefault();
    dragRef.current = { a: hit.i, b: hit.i, x0: ev.clientX };
    setDrag(dragRef.current);
  }, [onRangeSelect, locate, M.left, M.right, width]);

  // While dragging, follow the pointer even outside the plot, and finish on
  // release wherever it happens.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return undefined;
    const cancel = (): void => {
      dragRef.current = null;
      setDrag(null);
    };
    const move = (ev: MouseEvent): void => {
      const d = dragRef.current;
      // No button held means it was released where we could not hear it —
      // outside the window, over devtools — so the drag is over, not paused.
      if (d && ev.buttons === 0) { cancel(); return; }
      const hit = locate(ev.clientX);
      if (!d || !hit) return;
      dragRef.current = { ...d, b: hit.i };
      setDrag(dragRef.current);
    };
    const up = (ev: MouseEvent): void => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d) return;
      const hit = locate(ev.clientX);
      const b = hit ? hit.i : d.b;
      const lo = Math.min(d.a, b);
      const hi = Math.max(d.a, b);
      if (Math.abs(ev.clientX - d.x0) >= MIN_DRAG_PX && hi > lo) onRangeSelect?.(times[lo], times[hi]);
    };
    const key = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') cancel(); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', cancel);
    };
  }, [dragging, locate, onRangeSelect, times]);

  const tickIndices = useMemo(() => {
    const want = Math.min(8, Math.max(2, Math.floor(iw / 120)));
    return Array.from({ length: want }, (_, k) => Math.round((k / (want - 1)) * (n - 1)));
  }, [iw, n]);

  const hovered = hoverIndex !== null && !drag ? times[hoverIndex] : null;
  const readoutRows = hoverIndex === null ? [] : visible
    .map((s) => ({ s, v: s.points[hoverIndex] ?? null }))
    .filter((r): r is { s: Drawn; v: number } => r.v !== null)
    .sort((a, b) => (Number(b.s.emphasis === 'total') - Number(a.s.emphasis === 'total')) || (b.v - a.v));
  const base = hoverIndex === null || !shareBase ? null : (shareBase[hoverIndex] ?? null);
  const readoutOnRight = hoverIndex !== null && x(hoverIndex) < width / 2;
  const nearSpike = hoverIndex === null
    ? undefined
    : spikes.find((s) => Math.abs(s - hoverIndex) <= Math.max(1, Math.round(n * 0.012)));

  const brush = drag && drag.a !== drag.b
    ? { lo: Math.min(drag.a, drag.b), hi: Math.max(drag.a, drag.b) }
    : null;

  const notes = fullBleed && (cornerNote || badge) ? (
    <div className="flex items-center justify-between gap-3 pb-1.5">
      <div className="min-w-0">{cornerNote}</div>
      <div className="shrink-0">{badge}</div>
    </div>
  ) : null;

  return (
    <div ref={wrapRef} className={clsx('relative w-full', className)}>
      {notes}
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          height={height}
          role="img"
          aria-label={ariaLabel}
          onMouseMove={onMove}
          onMouseLeave={() => setHoverIndex(null)}
          onMouseDown={onDown}
          className={clsx('block select-none', onRangeSelect && 'cursor-crosshair')}
        >
          <defs>
            <linearGradient id="chart-total-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#7b8494" stopOpacity="0.2" />
              <stop offset="100%" stopColor="#7b8494" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {ticks.map((v) => (
            <line
              key={`g${v}`}
              x1={M.left} x2={width - M.right} y1={y(v)} y2={y(v)}
              className={v === 0 ? 'stroke-gray-300 dark:stroke-gray-600' : 'stroke-gray-200 dark:stroke-gray-700'}
              strokeWidth={1}
            />
          ))}
          {!fullBleed && ticks.map((v) => (
            <text
              key={`t${v}`} x={M.left - 8} y={y(v) + 4} textAnchor="end" data-testid="y-tick"
              className="fill-gray-500 text-[10px] tabular-nums dark:fill-gray-400"
            >
              {formatValue(v)}
            </text>
          ))}

          {order.map((s) => {
            const runs = measuredRuns(s.points);
            const isTotal = s.emphasis === 'total';
            const focused = s.key === focusKey;
            const dim = focusKey !== null && !focused;
            const area = (isTotal || focused) && runs.filter((r) => r.length > 1).map((r) => (
              <polygon
                key={`a${r[0]}`}
                points={`${r.map((i) => at(i, s.points[i] as number)).join(' ')} ${x(r[r.length - 1]).toFixed(1)},${y(0).toFixed(1)} ${x(r[0]).toFixed(1)},${y(0).toFixed(1)}`}
                fill={isTotal ? 'url(#chart-total-area)' : s.colour}
                fillOpacity={isTotal ? 1 : 0.18}
              />
            ));
            return (
              <g
                key={s.key}
                data-series={s.key}
                data-dim={dim ? 'true' : 'false'}
                className="transition-opacity duration-100"
                opacity={dim ? (isTotal ? 0.4 : 0.12) : 1}
              >
                {area}
                {runs.filter((r) => r.length > 1).map((r) => (
                  <polyline
                    key={`l${r[0]}`}
                    points={r.map((i) => at(i, s.points[i] as number)).join(' ')}
                    fill="none"
                    stroke={isTotal ? undefined : s.colour}
                    className={isTotal ? TOTAL_STROKE : undefined}
                    strokeWidth={focused ? baseWidth + 0.9 : isTotal ? baseWidth + 0.5 : baseWidth}
                    strokeLinecap={coarse ? 'butt' : 'round'}
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                {runs.filter((r) => r.length === 1).map(([i]) => (
                  <circle
                    key={`d${i}`} cx={x(i)} cy={y(s.points[i] as number)} r={1.8}
                    fill={isTotal ? undefined : s.colour} className={isTotal ? TOTAL_FILL : undefined}
                  />
                ))}
              </g>
            );
          })}

          {fullBleed && ticks.filter((v) => v > 0).map((v) => (
            <text
              key={`t${v}`} x={M.left + 4} y={y(v) - 5} data-testid="y-tick"
              className="fill-gray-500 stroke-white text-[10.5px] tabular-nums [paint-order:stroke] dark:fill-gray-400 dark:stroke-gray-800"
              strokeWidth={3} strokeLinejoin="round"
            >
              {formatValue(v)}
            </text>
          ))}

          {spikes.map((i) => (
            <line
              key={`s${i}`}
              x1={x(i)} x2={x(i)} y1={M.top + 4} y2={y(tops[i] ?? 0) - 5}
              className="stroke-amber-500" strokeWidth={1} strokeDasharray="2 3"
            />
          ))}

          {hoverIndex !== null && !drag && (
            <g pointerEvents="none">
              <line
                x1={x(hoverIndex)} x2={x(hoverIndex)} y1={M.top} y2={M.top + ih}
                className="stroke-gray-400 dark:stroke-gray-500" strokeWidth={1} strokeDasharray="3 3"
              />
              {order.map((s) => {
                const v = s.points[hoverIndex];
                if (v === null || v === undefined) return null;
                const dim = focusKey !== null && s.key !== focusKey;
                return (
                  <circle
                    key={`h${s.key}`} cx={x(hoverIndex)} cy={y(v)} r={3.5}
                    fill={s.emphasis === 'total' ? undefined : s.colour}
                    className={s.emphasis === 'total' ? TOTAL_FILL : undefined}
                    opacity={dim ? 0.2 : 1}
                  />
                );
              })}
            </g>
          )}

          {spikes.map((i) => (
            <g
              key={`m${i}`}
              data-testid="spike-marker"
              role="button"
              tabIndex={0}
              aria-label={`Spike at ${formatInstant(times[i])}${onZoom ? ', zoom in' : ''}`}
              className={clsx('group outline-none', onZoom && 'cursor-pointer')}
              onMouseDown={(ev) => ev.stopPropagation()}
              onClick={() => onZoom?.(times[i])}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault();
                  onZoom?.(times[i]);
                }
              }}
            >
              <title>{`Spike at ${formatInstant(times[i])}${onZoom ? ' — click to zoom' : ''}`}</title>
              {/* The target is much larger than the dot: a 4 px dot was hard to hit. */}
              <circle data-hit cx={x(i)} cy={M.top + 4} r={13} fill="transparent" />
              {/* Keyboard focus gets a ring, not only the size change hover gets. */}
              <circle
                cx={x(i)} cy={M.top + 4} r={11} fill="none" strokeWidth={2}
                className="stroke-blue-500 opacity-0 group-focus-visible:opacity-100 dark:stroke-blue-400"
              />
              <circle
                cx={x(i)} cy={M.top + 4} r={5}
                className="fill-amber-500 stroke-white transition-transform duration-100 group-hover:scale-[1.75] group-focus-visible:scale-[1.75] dark:stroke-gray-800"
                strokeWidth={2}
                style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
              />
            </g>
          ))}

          {brush && (
            <g pointerEvents="none" data-testid="chart-brush">
              <rect
                x={x(brush.lo)} y={M.top} width={Math.max(1, x(brush.hi) - x(brush.lo))} height={ih}
                className="fill-brand-500/15 stroke-brand-500/60 dark:fill-brand-300/20 dark:stroke-brand-300/70" strokeWidth={1}
              />
              <text
                x={(x(brush.lo) + x(brush.hi)) / 2} y={M.top + 16} textAnchor="middle"
                className="fill-brand-700 stroke-white text-[11px] font-semibold tabular-nums [paint-order:stroke] dark:fill-brand-300 dark:stroke-gray-800"
                strokeWidth={3}
              >
                {`${formatTick(times[brush.lo], stepSeconds)} – ${formatTick(times[brush.hi], stepSeconds)}`}
              </text>
            </g>
          )}

          {tickIndices.map((i) => (
            <text
              key={`x${i}`} x={x(i)} y={height - 8}
              textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
              className="fill-gray-500 text-[10px] tabular-nums dark:fill-gray-400"
            >
              {times[i] ? formatTick(times[i], stepSeconds) : ''}
            </text>
          ))}
        </svg>

        {hovered && hoverIndex !== null && (
          <div
            className="pointer-events-none absolute z-10 min-w-[220px] max-w-[min(360px,70%)] rounded-lg border border-gray-200
              bg-white/95 px-3 py-2 text-xs shadow-lg backdrop-blur dark:border-gray-700 dark:bg-gray-800/95"
            style={readoutOnRight
              ? { right: M.right + 8, top: M.top + 4 }
              : { left: fullBleed ? M.left + 8 : 74, top: M.top + 4 }}
            data-testid="chart-readout"
          >
            <div className="mb-1 font-medium tabular-nums text-gray-900 dark:text-gray-100">
              {formatInstant(hovered)}
            </div>
            {readoutRows.slice(0, 7).map(({ s, v }) => (
              <div
                key={s.key}
                className={clsx(
                  'flex items-center justify-between gap-4',
                  s.key === focusKey ? 'font-semibold text-gray-900 dark:text-gray-100' : 'text-gray-600 dark:text-gray-300',
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <i
                    className={clsx('inline-block h-2 w-2 shrink-0 rounded-sm', s.emphasis === 'total' && TOTAL_BG)}
                    style={s.emphasis === 'total' ? undefined : { background: s.colour }}
                  />
                  <span className="truncate">{s.name}</span>
                </span>
                <span className="shrink-0 tabular-nums text-gray-900 dark:text-gray-100">
                  {formatValue(v)}
                  {shareBase && s.emphasis !== 'total' && (
                    <span className="ml-2 inline-block min-w-[34px] text-right text-gray-500 dark:text-gray-400">
                      {percent(v, base)}
                    </span>
                  )}
                </span>
              </div>
            ))}
            {readoutRows.length > 7 && (
              <div className="text-gray-500 dark:text-gray-400">+ {readoutRows.length - 7} more</div>
            )}
            {formatStepTotal && shareBase && (
              <div className="mt-1 flex items-center justify-between gap-4 border-t border-gray-200 pt-1 dark:border-gray-700">
                <span className="text-gray-600 dark:text-gray-300">In this step</span>
                <span className="font-medium tabular-nums text-gray-900 dark:text-gray-100">
                  {formatStepTotal(base, stepSeconds)}
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

        {!fullBleed && !hovered && cornerNote && (
          <div className="pointer-events-none absolute left-[74px] top-[5px]">{cornerNote}</div>
        )}
        {!fullBleed && badge && <div className="pointer-events-none absolute right-4 top-[5px]">{badge}</div>}
      </div>
    </div>
  );
}

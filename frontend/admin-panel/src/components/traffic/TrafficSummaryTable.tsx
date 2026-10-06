/**
 * The summary table, which is also the legend.
 *
 * A separate legend strip would repeat the same names and colours, so the
 * rows do both jobs: each is a legend entry and a toggle. A hidden series
 * stays listed, dimmed and struck through — a series you cannot see and
 * cannot find again is just missing. Hovering a row highlights its line on
 * the chart and fades the others.
 *
 * The TREND column is the point of the table as much as the totals are: a
 * row of numbers says how much, the sparkline says what shape it had. It was
 * missing from the first build, which left the table a bare number grid.
 *
 * Fixed layout on purpose. With `auto`, switching metric re-flows every
 * column — "700 GB" and "6.6M req" and "25 ms" are different widths — and
 * the table shifts under the pointer mid-comparison.
 */

import clsx from 'clsx';
import type { TrafficFrame } from '@insula/api-contracts';
import { formatTrafficRate, formatTrafficVolume } from '@/lib/format-traffic';
import { decimateMinMax } from '@/components/charts/chart-scale';
import { TOTAL_BG, TOTAL_STROKE } from '@/components/charts/TimeSeriesChart';
import { colourForIndex } from './TrafficChart';
import { TOTAL_KEY } from './combined-line';

/** The combined row, when the view offers one. */
export interface SummaryTotal {
  readonly name: string;
  readonly points: ReadonlyArray<number | null>;
  /** Not drawn on the chart right now. */
  readonly off: boolean;
  /** Offered but unusable — fewer than two rows are shown. */
  readonly disabled: boolean;
}

export interface TrafficSummaryTableProps {
  readonly frame: TrafficFrame;
  readonly hidden: ReadonlySet<string>;
  readonly onToggle: (key: string) => void;
  /** Column heading for the name column, e.g. `Tenant` or `Direction`. */
  readonly subjectLabel: string;
  readonly total?: SummaryTotal | null;
  readonly focusKey?: string | null;
  /** Hovering a row asks the chart to highlight its line. */
  readonly onFocus?: (key: string | null) => void;
}

const SPARK_W = 120;
const SPARK_H = 20;

function integrate(points: ReadonlyArray<number | null>, stepSeconds: number): number {
  let total = 0;
  for (const v of points) if (v !== null && Number.isFinite(v)) total += v * stepSeconds;
  return total;
}

function meanOf(points: ReadonlyArray<number | null>): number | null {
  let sum = 0; let n = 0;
  for (const v of points) if (v !== null && Number.isFinite(v)) { sum += v; n += 1; }
  return n === 0 ? null : sum / n;
}

function peakOf(points: ReadonlyArray<number | null>): number | null {
  let best: number | null = null;
  for (const v of points) if (v !== null && Number.isFinite(v)) best = best === null ? v : Math.max(best, v);
  return best;
}

/**
 * Sparkline path for one series, scaled to its OWN peak.
 *
 * Per-series scaling on purpose: this column is about shape, not magnitude —
 * the numbers to its left already carry magnitude, and a shared scale would
 * flatten every small series into a straight line at the bottom.
 *
 * Thinned by keeping each bucket's lowest and highest point. Keeping every
 * Nth point instead dropped short spikes, so a spike on the chart above could
 * be missing from its own row. Gaps break the line here too.
 */
function sparkSegments(points: ReadonlyArray<number | null>): string[] {
  const peak = peakOf(points) ?? 0;
  const max = peak > 0 ? peak : 1;
  const last = Math.max(1, points.length - 1);
  const segments: string[] = [];
  let run: string[] = [];
  for (const { i, v } of decimateMinMax(points, 60)) {
    if (v === null) {
      if (run.length > 1) segments.push(run.join(' '));
      run = [];
      continue;
    }
    const x = (i / last) * SPARK_W;
    const y = SPARK_H - (v / max) * (SPARK_H - 2) - 1;
    run.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  if (run.length > 1) segments.push(run.join(' '));
  return segments;
}

const HEAD = 'whitespace-nowrap border-b border-gray-200 px-2.5 py-2 text-[10.5px] font-semibold uppercase '
  + 'tracking-[0.1em] text-gray-500 dark:border-gray-700 dark:text-gray-400';

export default function TrafficSummaryTable({
  frame, hidden, onToggle, subjectLabel, total, focusKey = null, onFocus,
}: TrafficSummaryTableProps) {
  const isLatency = frame.unit === 'milliseconds';
  const figure = (points: ReadonlyArray<number | null>): number | null => (
    isLatency ? meanOf(points) : integrate(points, frame.stepSeconds)
  );
  const rows = frame.series.map((s, i) => ({
    s, colour: colourForIndex(i), total: figure(s.points), peak: peakOf(s.points),
  }));
  // Share is of the group a row belongs to. A subset of the wire is not a
  // share OF the wire plus the workload rows, and the workload rows do not
  // decompose the wire at all — one grand total across both would be a
  // percentage of a number that means nothing.
  const grandOf = (group: string | undefined): number => (isLatency ? 0 : rows
    .filter((r) => (r.s.group ?? '-') === (group ?? '-'))
    .reduce((a, r) => a + (r.total ?? 0), 0));

  const GROUP_LABEL: Record<string, string> = {
    wire: 'At the wire — internet and between nodes, each byte once',
    n2n: 'Between nodes — by what it was',
    'wire-subset': 'Part of the internet traffic, seen another way',
    nic: 'Every node’s network card added up — between-node bytes count twice',
    // Retained only so an older frame still renders a heading. Cluster
    // traffic no longer emits this group: pod-measured rows under a
    // wire-measured heading invited exactly the comparison they could
    // not survive.
    workload: 'Measured at the pod — includes traffic inside the cluster',
  };
  const groupsInOrder = [...new Set(rows.map((r) => r.s.group))]
    .filter((g): g is NonNullable<typeof g> => Boolean(g));

  const rowFor = (r: typeof rows[number], grand: number) => (
    <Row
      key={r.s.key}
      rowKey={r.s.key}
      name={r.s.name}
      points={r.s.points}
      colour={r.colour}
      total={r.total}
      peak={r.peak}
      share={isLatency || !grand ? '' : `${(((r.total ?? 0) / grand) * 100).toFixed(1)}%`}
      off={hidden.has(r.s.key)}
      focused={focusKey === r.s.key}
      unit={frame.unit}
      isLatency={isLatency}
      onToggle={onToggle}
      onFocus={onFocus}
    />
  );

  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
        <table className="w-full table-fixed border-collapse text-[13.5px]" data-testid="traffic-summary">
          <thead>
            <tr>
              <th className={clsx(HEAD, 'w-[26px] pl-2.5 pr-0 text-left')} aria-label="Colour" />
              <th className={clsx(HEAD, 'truncate text-left')}>{subjectLabel}</th>
              <th className={clsx(HEAD, 'w-[124px] text-right')}>{isLatency ? 'Average' : 'Total'}</th>
              <th className={clsx(HEAD, 'w-[124px] text-right')}>Peak</th>
              <th className={clsx(HEAD, 'w-[84px] text-right')}>{isLatency ? '' : 'Share'}</th>
              <th className={clsx(HEAD, 'w-[132px] text-left')}>Trend</th>
            </tr>
          </thead>
          <tbody>
            {total && (
              <Row
                rowKey={TOTAL_KEY}
                name={total.name}
                points={total.points}
                colourClass={TOTAL_BG}
                strokeClass={TOTAL_STROKE}
                total={figure(total.points)}
                peak={peakOf(total.points)}
                share={isLatency ? '' : '100%'}
                off={total.off}
                disabled={total.disabled}
                focused={focusKey === TOTAL_KEY}
                unit={frame.unit}
                isLatency={isLatency}
                emphasised
                onToggle={onToggle}
                onFocus={onFocus}
              />
            )}
            {groupsInOrder.length > 0 && groupsInOrder.flatMap((group) => [
              <tr key={`hd-${group}`}>
                <td
                  colSpan={6}
                  className="border-b border-gray-200 bg-gray-50 px-2.5 py-1.5 text-[10.5px]
                    font-semibold uppercase tracking-[0.1em] text-gray-500
                    dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-400"
                >
                  {GROUP_LABEL[group] ?? group}
                </td>
              </tr>,
              ...rows.filter((r) => r.s.group === group).map((r) => rowFor(r, grandOf(r.s.group))),
            ])}
            {groupsInOrder.length === 0 && rows.map((r) => rowFor(r, grandOf(undefined)))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-gray-500 dark:text-gray-400">
                  Nothing was recorded in this range.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {frame.othersFolded > 0 && frame.unit === 'milliseconds' && (
        <p className="pt-2 text-xs text-gray-500 dark:text-gray-400">
          {frame.othersFolded} more not shown. Averages cannot be summed into an “other” row without
          inventing a figure that belongs to nobody.
        </p>
      )}
    </>
  );
}

interface RowProps {
  readonly rowKey: string;
  readonly name: string;
  readonly points: ReadonlyArray<number | null>;
  /** A palette colour; or, for the total, a class pair per theme. */
  readonly colour?: string;
  readonly colourClass?: string;
  readonly strokeClass?: string;
  readonly total: number | null;
  readonly peak: number | null;
  readonly share: string;
  readonly off: boolean;
  readonly disabled?: boolean;
  readonly focused: boolean;
  readonly emphasised?: boolean;
  readonly isLatency: boolean;
  readonly unit: TrafficFrame['unit'];
  readonly onToggle: (key: string) => void;
  readonly onFocus?: (key: string | null) => void;
}

/** One series: legend swatch, name, figures, share within its group, shape. */
function Row({
  rowKey, name, points, colour, colourClass, strokeClass, total, peak, share, off, disabled = false,
  focused, emphasised = false, isLatency, unit, onToggle, onFocus,
}: RowProps) {
  const cell = 'whitespace-nowrap border-b border-gray-200 dark:border-gray-700';
  const dim = off && 'opacity-40';
  const toggle = (): void => { if (!disabled) onToggle(rowKey); };
  return (
    <tr
      data-series={rowKey}
      tabIndex={disabled ? -1 : 0}
      role="button"
      aria-pressed={!off}
      aria-disabled={disabled || undefined}
      title={disabled
        ? 'Show at least two rows to use the total'
        : off ? `Show ${name}` : `Hide ${name}`}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      }}
      // Only a series on the chart can be highlighted there.
      onMouseEnter={() => { if (!off) onFocus?.(rowKey); }}
      onMouseLeave={() => onFocus?.(null)}
      onFocus={() => { if (!off) onFocus?.(rowKey); }}
      onBlur={() => onFocus?.(null)}
      className={clsx(
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700/50',
        focused && 'bg-gray-100 dark:bg-gray-700/50',
      )}
    >
      <td className={clsx(cell, 'py-2 pl-2.5 pr-0', dim)}>
        <span
          className={clsx('inline-block h-2.5 w-2.5 rounded-sm', colourClass)}
          style={colour ? { background: colour } : undefined}
        />
      </td>
      <td
        className={clsx(
          cell, 'truncate px-2.5 py-2 text-gray-900 dark:text-gray-100',
          emphasised && 'font-semibold', off && 'opacity-40 line-through',
        )}
        title={name}
      >
        {name}
      </td>
      <td className={clsx(cell, 'px-2.5 py-2 text-right font-mono tabular-nums text-gray-700 dark:text-gray-300', dim)}>
        {isLatency ? formatTrafficRate(total, unit) : formatTrafficVolume(total, unit)}
      </td>
      <td className={clsx(cell, 'px-2.5 py-2 text-right font-mono tabular-nums text-gray-700 dark:text-gray-300', dim)}>
        {formatTrafficRate(peak, unit)}
      </td>
      <td className={clsx(cell, 'px-2.5 py-2 text-right font-mono tabular-nums text-gray-500 dark:text-gray-400', dim)}>
        {share}
      </td>
      <td className={clsx('border-b border-gray-200 px-2.5 py-2 dark:border-gray-700', dim)}>
        <svg
          viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
          width="100%"
          height={SPARK_H}
          preserveAspectRatio="none"
          aria-hidden="true"
          className="block"
        >
          {sparkSegments(points).map((pts, si) => (
            <polyline
              key={si}
              points={pts}
              fill="none"
              stroke={colour}
              className={strokeClass}
              strokeWidth={1.9}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      </td>
    </tr>
  );
}

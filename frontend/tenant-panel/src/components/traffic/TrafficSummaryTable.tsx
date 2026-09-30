/**
 * The summary table, which is also the legend.
 *
 * A separate legend strip would repeat the same names and colours, so the
 * rows do both jobs: each is a legend entry and a toggle. A hidden series
 * stays listed, dimmed and struck through — a series you cannot see and
 * cannot find again is just missing.
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
import { colourForIndex } from './TrafficChart';

export interface TrafficSummaryTableProps {
  readonly frame: TrafficFrame;
  readonly hidden: ReadonlySet<string>;
  readonly onToggle: (key: string) => void;
  /** Column heading for the name column, e.g. `Tenant` or `Direction`. */
  readonly subjectLabel: string;
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
 * Gaps break the line here too, for the same reason they do on the chart.
 */
function sparkSegments(points: ReadonlyArray<number | null>): string[] {
  const peak = peakOf(points) ?? 0;
  const max = peak > 0 ? peak : 1;
  const step = Math.max(1, Math.floor(points.length / 60));
  const sampled = points.filter((_, i) => i % step === 0);
  const segments: string[] = [];
  let run: string[] = [];
  sampled.forEach((v, i) => {
    if (v === null) {
      if (run.length > 1) segments.push(run.join(' '));
      run = [];
      return;
    }
    const x = (i / Math.max(1, sampled.length - 1)) * SPARK_W;
    const y = SPARK_H - (v / max) * (SPARK_H - 2) - 1;
    run.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (run.length > 1) segments.push(run.join(' '));
  return segments;
}

export default function TrafficSummaryTable({
  frame, hidden, onToggle, subjectLabel,
}: TrafficSummaryTableProps) {
  const isLatency = frame.unit === 'milliseconds';
  const rows = frame.series.map((s, i) => {
    const total = isLatency ? meanOf(s.points) : integrate(s.points, frame.stepSeconds);
    return { s, colour: colourForIndex(i), total, peak: peakOf(s.points) };
  });
  // Share is of the group a row belongs to. A subset of the wire is not a
  // share OF the wire plus the workload rows, and the workload rows do not
  // decompose the wire at all — one grand total across both would be a
  // percentage of a number that means nothing.
  const grandOf = (group: string | undefined): number => (isLatency ? 0 : rows
    .filter((r) => (r.s.group ?? '-') === (group ?? '-'))
    .reduce((a, r) => a + (r.total ?? 0), 0));

  const GROUP_LABEL: Record<string, string> = {
    wire: 'At the wire — what crossed the network',
    'wire-subset': 'Part of that same total, seen another way',
    // Retained only so an older frame still renders a heading. Cluster
    // traffic no longer emits this group: pod-measured rows under a
    // wire-measured heading invited exactly the comparison they could
    // not survive.
    workload: 'Measured at the pod — includes traffic inside the cluster',
  };
  const groupsInOrder = [...new Set(rows.map((r) => r.s.group))]
    .filter((g): g is NonNullable<typeof g> => Boolean(g));

  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
        <table className="w-full table-fixed border-collapse text-[13.5px]" data-testid="traffic-summary">
          <thead>
            <tr>
              <th
                className="w-[26px] whitespace-nowrap border-b border-gray-200 py-2 pl-2.5 pr-0 text-left
                  text-[10.5px] font-semibold uppercase tracking-[0.1em] text-gray-500
                  dark:border-gray-700 dark:text-gray-400"
                aria-label="Colour"
              />
              <th className="truncate whitespace-nowrap border-b border-gray-200 px-2.5 py-2 text-left
                text-[10.5px] font-semibold uppercase tracking-[0.1em] text-gray-500
                dark:border-gray-700 dark:text-gray-400"
              >
                {subjectLabel}
              </th>
              <th className="w-[124px] whitespace-nowrap border-b border-gray-200 px-2.5 py-2 text-right
                text-[10.5px] font-semibold uppercase tracking-[0.1em] text-gray-500
                dark:border-gray-700 dark:text-gray-400"
              >
                {isLatency ? 'Average' : 'Total'}
              </th>
              <th className="w-[124px] whitespace-nowrap border-b border-gray-200 px-2.5 py-2 text-right
                text-[10.5px] font-semibold uppercase tracking-[0.1em] text-gray-500
                dark:border-gray-700 dark:text-gray-400"
              >
                Peak
              </th>
              <th className="w-[84px] whitespace-nowrap border-b border-gray-200 px-2.5 py-2 text-right
                text-[10.5px] font-semibold uppercase tracking-[0.1em] text-gray-500
                dark:border-gray-700 dark:text-gray-400"
              >
                {isLatency ? '' : 'Share'}
              </th>
              <th className="w-[132px] whitespace-nowrap border-b border-gray-200 px-2.5 py-2 text-left
                text-[10.5px] font-semibold uppercase tracking-[0.1em] text-gray-500
                dark:border-gray-700 dark:text-gray-400"
              >
                Trend
              </th>
            </tr>
          </thead>
          <tbody>
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
              ...rows.filter((r) => r.s.group === group).map(({ s, colour, total, peak }) => (
                <Row
                  key={s.key}
                  s={s}
                  colour={colour}
                  total={total}
                  peak={peak}
                  off={hidden.has(s.key)}
                  grand={grandOf(s.group)}
                  isLatency={isLatency}
                  unit={frame.unit}
                  onToggle={onToggle}
                />
              )),
            ])}
            {groupsInOrder.length === 0 && rows.map(({ s, colour, total, peak }) => (
              <Row
                key={s.key}
                s={s}
                colour={colour}
                total={total}
                peak={peak}
                off={hidden.has(s.key)}
                grand={grandOf(undefined)}
                isLatency={isLatency}
                unit={frame.unit}
                onToggle={onToggle}
              />
            ))}
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
  readonly s: TrafficFrame['series'][number];
  readonly colour: string;
  readonly total: number | null;
  readonly peak: number | null;
  readonly off: boolean;
  readonly grand: number;
  readonly isLatency: boolean;
  readonly unit: TrafficFrame['unit'];
  readonly onToggle: (key: string) => void;
}

/** One series: legend swatch, name, figures, share within its group, shape. */
function Row({ s, colour, total, peak, off, grand, isLatency, unit, onToggle }: RowProps) {
  return (

                <tr
                  key={s.key}
                  data-series={s.key}
                  tabIndex={0}
                  role="button"
                  aria-pressed={!off}
                  title={off ? 'Show this series' : 'Hide this series'}
                  onClick={() => onToggle(s.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(s.key); }
                  }}
                  className="cursor-pointer hover:bg-gray-100 focus:outline-none
                    focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500
                    dark:hover:bg-gray-700/50"
                >
                  <td className={clsx(
                    'whitespace-nowrap border-b border-gray-200 py-2 pl-2.5 pr-0 dark:border-gray-700',
                    off && 'opacity-40',
                  )}
                  >
                    <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: colour }} />
                  </td>
                  <td
                    className={clsx(
                      'truncate whitespace-nowrap border-b border-gray-200 px-2.5 py-2',
                      'text-gray-900 dark:border-gray-700 dark:text-gray-100',
                      off && 'opacity-40 line-through',
                    )}
                    title={s.name}
                  >
                    {s.name}
                  </td>
                  <td className={clsx(
                    'whitespace-nowrap border-b border-gray-200 px-2.5 py-2 text-right font-mono tabular-nums',
                    'text-gray-700 dark:border-gray-700 dark:text-gray-300', off && 'opacity-40',
                  )}
                  >
                    {isLatency ? formatTrafficRate(total, unit) : formatTrafficVolume(total, unit)}
                  </td>
                  <td className={clsx(
                    'whitespace-nowrap border-b border-gray-200 px-2.5 py-2 text-right font-mono tabular-nums',
                    'text-gray-700 dark:border-gray-700 dark:text-gray-300', off && 'opacity-40',
                  )}
                  >
                    {formatTrafficRate(peak, unit)}
                  </td>
                  <td className={clsx(
                    'whitespace-nowrap border-b border-gray-200 px-2.5 py-2 text-right font-mono tabular-nums',
                    'text-gray-500 dark:border-gray-700 dark:text-gray-400', off && 'opacity-40',
                  )}
                  >
                    {isLatency || !grand ? '' : `${(((total ?? 0) / grand) * 100).toFixed(1)}%`}
                  </td>
                  <td className={clsx(
                    'border-b border-gray-200 px-2.5 py-2 dark:border-gray-700', off && 'opacity-40',
                  )}
                  >
                    <svg
                      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
                      width="100%"
                      height={SPARK_H}
                      preserveAspectRatio="none"
                      aria-hidden="true"
                      className="block"
                    >
                      {sparkSegments(s.points).map((pts, si) => (
                        <polyline
                          key={si}
                          points={pts}
                          fill="none"
                          stroke={colour}
                          strokeWidth={1.4}
                          vectorEffect="non-scaling-stroke"
                        />
                      ))}
                    </svg>
                  </td>
                </tr>
  );
}

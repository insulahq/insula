/**
 * The summary table, which is also the legend.
 *
 * A separate legend strip would repeat the same names and colours the table
 * already carries, so the rows do both jobs: each is a legend entry and a
 * toggle. Hidden series stay listed, dimmed and struck through, because a
 * series you cannot see and cannot find again is just missing.
 *
 * Fixed layout on purpose — with `auto`, switching metric re-flows every
 * column, and the table shifts under the pointer mid-comparison.
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

export default function TrafficSummaryTable({
  frame, hidden, onToggle, subjectLabel,
}: TrafficSummaryTableProps) {
  const isLatency = frame.unit === 'milliseconds';
  const rows = frame.series.map((s, i) => {
    const total = isLatency ? meanOf(s.points) : integrate(s.points, frame.stepSeconds);
    return { s, colour: colourForIndex(i), total, peak: peakOf(s.points) };
  });
  const grand = isLatency ? 0 : rows.reduce((a, r) => a + (r.total ?? 0), 0);

  return (
    <div className="overflow-x-auto">
      <table className="w-full table-fixed text-sm" data-testid="traffic-summary">
        <thead>
          <tr className="border-b border-gray-200 text-left text-[11px] uppercase tracking-wider
            text-gray-500 dark:border-gray-700 dark:text-gray-400">
            <th className="w-[26px] py-2" aria-label="Colour" />
            <th className="py-2 font-medium">{subjectLabel}</th>
            <th className="w-[124px] py-2 text-right font-medium">{isLatency ? 'Average' : 'Total'}</th>
            <th className="w-[124px] py-2 text-right font-medium">Peak</th>
            <th className="w-[84px] py-2 text-right font-medium">{isLatency ? '' : 'Share'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ s, colour, total, peak }) => {
            const off = hidden.has(s.key);
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
                className="cursor-pointer border-b border-gray-100 last:border-0 hover:bg-gray-50
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500
                  dark:border-gray-800 dark:hover:bg-gray-800/50"
              >
                <td className={clsx('py-2', off && 'opacity-40')}>
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: colour }} />
                </td>
                <td className={clsx(
                  'truncate py-2 text-gray-900 dark:text-gray-100',
                  off && 'opacity-40 line-through',
                )} title={s.name}
                >
                  {s.name}
                </td>
                <td className={clsx('py-2 text-right tabular-nums text-gray-700 dark:text-gray-300', off && 'opacity-40')}>
                  {isLatency ? formatTrafficRate(total, frame.unit) : formatTrafficVolume(total, frame.unit)}
                </td>
                <td className={clsx('py-2 text-right tabular-nums text-gray-700 dark:text-gray-300', off && 'opacity-40')}>
                  {formatTrafficRate(peak, frame.unit)}
                </td>
                <td className={clsx('py-2 text-right tabular-nums text-gray-500 dark:text-gray-400', off && 'opacity-40')}>
                  {isLatency || !grand ? '' : `${(((total ?? 0) / grand) * 100).toFixed(1)}%`}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="py-6 text-center text-gray-500 dark:text-gray-400">
                Nothing was recorded in this range.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {frame.othersFolded > 0 && frame.unit === 'milliseconds' && (
        <p className="pt-2 text-xs text-gray-500 dark:text-gray-400">
          {frame.othersFolded} more not shown. Averages cannot be summed into an “other” row without
          inventing a figure that belongs to nobody.
        </p>
      )}
    </div>
  );
}

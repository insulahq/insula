/**
 * The four summary tiles above the chart.
 *
 * Deliberately NOT `ui/StatCard`: that component is the console's tile —
 * left accent bar, icon, larger type — and using it here made this row read
 * as four dashboard cards rather than as a compact read-out belonging to the
 * chart below it. This matches the agreed design: a small uppercase key, a
 * 19px tabular value, a muted sub-line, and an `alert` variant that recolours
 * the whole tile rather than adding a stripe.
 */

import clsx from 'clsx';

export interface TrafficStat {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
  /** Recolours the tile — used when a reading needs qualifying, not decorating. */
  readonly alert?: boolean;
}

export default function TrafficStats({ stats }: { stats: readonly TrafficStat[] }) {
  if (stats.length === 0) return null;
  return (
    <div
      className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]"
      data-testid="traffic-stats"
    >
      {stats.map((s) => (
        <div
          key={s.key}
          data-stat={s.key}
          className={clsx(
            'rounded-lg border px-3 py-2.5',
            s.alert
              ? 'border-amber-500 bg-amber-50 dark:border-amber-500 dark:bg-amber-950/30'
              : 'border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/40',
          )}
        >
          <div className={clsx(
            'text-[10.5px] font-semibold uppercase tracking-[0.1em]',
            s.alert ? 'text-amber-700 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400',
          )}
          >
            {s.label}
          </div>
          <div className={clsx(
            'text-[19px] font-semibold leading-tight tracking-[-0.01em] tabular-nums',
            s.alert ? 'text-amber-700 dark:text-amber-400' : 'text-gray-900 dark:text-gray-100',
          )}
          >
            {s.value}
          </div>
          {s.sub && (
            <div className={clsx(
              'text-xs tabular-nums',
              s.alert ? 'text-amber-700 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400',
            )}
            >
              {s.sub}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

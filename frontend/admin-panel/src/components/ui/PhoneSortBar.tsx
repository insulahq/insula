import clsx from 'clsx';
import { ChevronDown, ChevronUp } from 'lucide-react';

export interface PhoneSortOption {
  readonly key: string;
  readonly label: string;
}

interface PhoneSortBarProps {
  readonly options: ReadonlyArray<PhoneSortOption>;
  readonly sortKey: string;
  readonly direction: 'asc' | 'desc';
  readonly onSort: (key: string) => void;
  readonly className?: string;
}

/**
 * The column headings of a table shown as cards on a phone, as sort buttons:
 * the cards have no heading row to click. Same `onSort` as the table's
 * headings, so both views share one sort.
 */
export default function PhoneSortBar({ options, sortKey, direction, onSort, className }: PhoneSortBarProps) {
  return (
    <div className={clsx('flex flex-wrap items-center gap-1.5', className)} role="group" aria-label="Sort by" data-testid="phone-sort-bar">
      <span className="text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Sort</span>
      {options.map((o) => {
        const active = o.key === sortKey;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onSort(o.key)}
            aria-pressed={active}
            className={clsx(
              'inline-flex items-center gap-0.5 rounded-md border px-2 py-1 text-xs font-medium',
              active
                ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-700 dark:bg-brand-950 dark:text-brand-300'
                : 'border-gray-200 bg-white text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300',
            )}
            data-testid={`phone-sort-${o.key}`}
          >
            {o.label}
            {active && (direction === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
          </button>
        );
      })}
    </div>
  );
}

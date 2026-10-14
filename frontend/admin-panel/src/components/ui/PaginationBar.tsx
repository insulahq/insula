import { useId } from 'react';
import clsx from 'clsx';
import { ALL_ROWS } from '@/hooks/use-table-view';

const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

interface PaginationBarProps {
  readonly totalCount: number;
  readonly pageSize: number;
  readonly pageIndex: number;
  readonly hasPrevPage: boolean;
  readonly hasNextPage: boolean;
  readonly onNext: () => void;
  readonly onPrev: () => void;
  readonly onPageSizeChange: (size: number) => void;
  /** Offer "All" ({@link ALL_ROWS}) beside the fixed sizes. */
  readonly allowAll?: boolean;
  /** Distinguishes the controls when a page carries several tables. */
  readonly testIdPrefix?: string;
}

export default function PaginationBar({
  totalCount,
  pageSize,
  pageIndex,
  hasPrevPage,
  hasNextPage,
  onNext,
  onPrev,
  onPageSizeChange,
  allowAll = false,
  testIdPrefix = '',
}: PaginationBarProps) {
  const selectId = useId();
  const showingAll = pageSize === ALL_ROWS;
  const rangeStart = totalCount === 0 ? 0 : showingAll ? 1 : pageIndex * pageSize + 1;
  const rangeEnd = showingAll ? totalCount : Math.min(rangeStart + pageSize - 1, totalCount);
  const tid = (name: string): string => `${testIdPrefix}${name}`;

  return (
    <div
      className="flex items-center justify-between border-t border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800"
      data-testid={tid('pagination-bar')}
    >
      {/* Left: range text */}
      <p className="text-sm text-gray-700 dark:text-gray-300">
        Showing{' '}
        <span className="font-medium">{rangeStart}</span>
        {'-'}
        <span className="font-medium">{rangeEnd}</span>
        {' of '}
        <span className="font-medium">{totalCount}</span>
      </p>

      {/* Center: page size dropdown */}
      <div className="flex items-center gap-2">
        <label
          htmlFor={selectId}
          className="text-sm text-gray-600 dark:text-gray-400"
        >
          Rows per page:
        </label>
        <select
          id={selectId}
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          className={clsx(
            'rounded border border-gray-300 bg-white px-2 py-1 text-sm',
            'focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500',
            'dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200',
            'dark:focus:border-blue-400 dark:focus:ring-blue-400',
          )}
          data-testid={tid('page-size-select')}
        >
          {PAGE_SIZE_OPTIONS.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
          {allowAll && <option value={ALL_ROWS}>All</option>}
        </select>
      </div>

      {/* Right: prev/next buttons */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!hasPrevPage}
          onClick={onPrev}
          className={clsx(
            'rounded border px-3 py-1.5 text-sm font-medium transition-colors',
            hasPrevPage
              ? 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600'
              : 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-600',
          )}
          data-testid={tid('pagination-prev')}
        >
          Previous
        </button>
        <button
          type="button"
          disabled={!hasNextPage}
          onClick={onNext}
          className={clsx(
            'rounded border px-3 py-1.5 text-sm font-medium transition-colors',
            hasNextPage
              ? 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600'
              : 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-600',
          )}
          data-testid={tid('pagination-next')}
        >
          Next
        </button>
      </div>
    </div>
  );
}

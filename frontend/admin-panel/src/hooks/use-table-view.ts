import { useMemo, useState } from 'react';
import { sortRows, type SortAccessors, type SortDirection } from './use-sortable';

/**
 * Page size that shows every row. A named value, never 0: a page size of 0
 * that means "all" is one stray default away from a table that shows nothing.
 */
export const ALL_ROWS = -1;

export interface TableViewQuery<T> {
  readonly search: string;
  /** The text a row is found by — what the search box matches, case-insensitively. */
  readonly searchText: (row: T) => string;
  readonly sortKey: string;
  readonly sortDirection: SortDirection;
  readonly accessors?: SortAccessors<T>;
  readonly pageIndex: number;
  /** Rows per page, or {@link ALL_ROWS}. */
  readonly pageSize: number;
}

export interface TableViewPage<T> {
  /** The rows on the page shown. */
  readonly rows: readonly T[];
  /** Rows that match the search, on every page. */
  readonly total: number;
  /** The page shown — the one asked for, or the last one when the search left fewer. */
  readonly pageIndex: number;
  readonly pageCount: number;
}

/**
 * Pure: search, then sort, then page. Search first so the count and the pages
 * are of what matches; sort before paging so page 2 continues page 1's order
 * rather than sorting each page on its own.
 */
export function viewRows<T>(data: readonly T[], q: TableViewQuery<T>): TableViewPage<T> {
  const needle = q.search.trim().toLowerCase();
  const matched = needle === ''
    ? data
    : data.filter((row) => q.searchText(row).toLowerCase().includes(needle));
  const sorted = sortRows(matched, q.sortKey, q.sortDirection, q.accessors);
  const total = sorted.length;
  if (q.pageSize === ALL_ROWS || q.pageSize <= 0) {
    return { rows: sorted, total, pageIndex: 0, pageCount: 1 };
  }
  const pageCount = Math.max(1, Math.ceil(total / q.pageSize));
  const pageIndex = Math.min(Math.max(0, q.pageIndex), pageCount - 1);
  const start = pageIndex * q.pageSize;
  return { rows: sorted.slice(start, start + q.pageSize), total, pageIndex, pageCount };
}

export interface TableViewOptions<T> {
  readonly searchText: (row: T) => string;
  readonly defaultSortKey: string;
  readonly defaultDirection?: SortDirection;
  readonly accessors?: SortAccessors<T>;
  readonly defaultPageSize?: number;
}

export interface TableView<T> extends TableViewPage<T> {
  readonly search: string;
  readonly setSearch: (value: string) => void;
  readonly sortKey: string;
  readonly sortDirection: SortDirection;
  readonly onSort: (key: string) => void;
  readonly pageSize: number;
  readonly setPageSize: (size: number) => void;
  readonly hasPrevPage: boolean;
  readonly hasNextPage: boolean;
  readonly goPrev: () => void;
  readonly goNext: () => void;
}

/**
 * Search, sort and pages for a table whose rows are all in the browser.
 *
 * A new search or page size starts again at page 1: staying on page 4 of a
 * result that now has one page shows nothing, and the reader takes the empty
 * table for "no match".
 */
export function useTableView<T>(data: readonly T[], options: TableViewOptions<T>): TableView<T> {
  const { searchText, defaultSortKey, defaultDirection = 'asc', accessors, defaultPageSize = 20 } = options;
  const [search, setSearchState] = useState('');
  const [sort, setSort] = useState<{ key: string; direction: SortDirection }>({ key: defaultSortKey, direction: defaultDirection });
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSizeState] = useState(defaultPageSize);

  const page = useMemo(
    () => viewRows(data, { search, searchText, sortKey: sort.key, sortDirection: sort.direction, accessors, pageIndex, pageSize }),
    [data, search, searchText, sort.key, sort.direction, accessors, pageIndex, pageSize],
  );

  return {
    ...page,
    search,
    setSearch: (value) => { setSearchState(value); setPageIndex(0); },
    sortKey: sort.key,
    sortDirection: sort.direction,
    onSort: (key) => setSort((prev) => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    })),
    pageSize,
    setPageSize: (size) => { setPageSizeState(size); setPageIndex(0); },
    hasPrevPage: page.pageIndex > 0,
    hasNextPage: page.pageIndex < page.pageCount - 1,
    goPrev: () => setPageIndex(Math.max(0, page.pageIndex - 1)),
    goNext: () => setPageIndex(Math.min(page.pageCount - 1, page.pageIndex + 1)),
  };
}

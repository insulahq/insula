import { useState, useMemo } from 'react';

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  readonly key: string;
  readonly direction: SortDirection;
}

export interface UseSortableResult<T> {
  readonly sortedData: readonly T[];
  readonly sortKey: string;
  readonly sortDirection: SortDirection;
  readonly onSort: (key: string) => void;
}

/**
 * Per-column sort values for columns that do not map to one field of the row:
 * a value looked up elsewhere (live metrics), or one derived for display (a
 * node's alias). A key without an accessor sorts by `row[key]`.
 */
export type SortAccessors<T> = Readonly<Record<string, (row: T) => unknown>>;

function getValue(obj: unknown, key: string): unknown {
  if (obj == null || typeof obj !== 'object') return undefined;
  return (obj as Record<string, unknown>)[key];
}

/**
 * Ascending order of two sort values. Numbers compare numerically, strings
 * case-insensitively and with numeric runs compared as numbers (`node-2`
 * before `node-10`). `null`/`undefined` — no value to show — sort after every
 * value; {@link sortRows} flips the whole result for descending.
 */
export function compareSortValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;

  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') {
    return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
  }

  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
}

/** Pure: a sorted copy of `data`. Stable, so equal values keep their order. */
export function sortRows<T>(
  data: readonly T[],
  key: string,
  direction: SortDirection,
  accessors?: SortAccessors<T>,
): T[] {
  const read = accessors?.[key] ?? ((row: T) => getValue(row, key));
  const copy = [...data];
  copy.sort((a, b) => {
    const result = compareSortValues(read(a), read(b));
    return direction === 'asc' ? result : -result;
  });
  return copy;
}

export function useSortable<T>(
  data: readonly T[],
  defaultKey: string,
  defaultDirection: SortDirection = 'asc',
  accessors?: SortAccessors<T>,
): UseSortableResult<T> {
  const [sort, setSort] = useState<SortState>({ key: defaultKey, direction: defaultDirection });

  const onSort = (key: string) => {
    setSort((prev) => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    }));
  };

  const sortedData = useMemo(
    () => sortRows(data, sort.key, sort.direction, accessors),
    [data, sort.key, sort.direction, accessors],
  );

  return { sortedData, sortKey: sort.key, sortDirection: sort.direction, onSort };
}

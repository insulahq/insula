import { useState } from 'react';
import type { SortDirection } from '@/hooks/use-sortable';

export interface UseServerSortResult {
  readonly sortKey: string;
  readonly sortDirection: SortDirection;
  /** Same toggle as useSortable: a new column sorts ascending, the same one flips. */
  readonly onSort: (key: string) => void;
  /** The `sort` query value for the list endpoint: `field:asc|desc`. */
  readonly sortParam: string;
}

/**
 * Sort state for a list the SERVER pages through.
 *
 * Sorting such a list in the browser orders only the page it holds — clicking
 * a column on a 20-row page of 140 tenants reordered those 20. The server
 * sorts the whole list instead (backend shared/list-sort.ts), and a sort
 * change starts again from page one: `onChange` is where the caller resets
 * its cursor, because a cursor belongs to the order it was made in.
 */
export function useServerSort(
  defaultKey: string,
  defaultDirection: SortDirection = 'asc',
  onChange?: () => void,
): UseServerSortResult {
  const [sort, setSort] = useState<{ key: string; direction: SortDirection }>({
    key: defaultKey,
    direction: defaultDirection,
  });

  const onSort = (key: string) => {
    setSort((prev) => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    }));
    onChange?.();
  };

  return {
    sortKey: sort.key,
    sortDirection: sort.direction,
    onSort,
    sortParam: `${sort.key}:${sort.direction}`,
  };
}

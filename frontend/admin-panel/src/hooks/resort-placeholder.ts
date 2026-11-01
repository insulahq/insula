interface PagedResult {
  readonly pagination?: {
    readonly cursor?: string | null;
    readonly has_more?: boolean;
  } | null;
}

interface ResortMeta {
  readonly resortList?: string;
  readonly resortSort?: string | null;
}

export interface ResortPlaceholderOptions<T> {
  readonly meta: Record<string, unknown>;
  readonly placeholderData: (
    previous: T | undefined,
    previousQuery: { readonly meta?: Record<string, unknown> } | undefined,
  ) => T | undefined;
}

/**
 * Query options that keep a server-sorted table's rows on screen while it
 * re-sorts.
 *
 * The sort is part of the query key, so a header click starts a new query
 * with no data. Without a placeholder the table drops to its loading state,
 * its headers unmount, and a keyboard user loses focus on the header they
 * just pressed. These options keep the rows already on screen until the new
 * order arrives, but only for a re-sort of the same list on its first page:
 * after a filter, search, page or tenant change the old rows belong to a
 * different list, and the loading state is the honest one.
 *
 * `list` is everything that identifies the list except its sort and cursor.
 * The kept rows lose their next-page cursor, because it was made in the old
 * order and the server refuses it under the new one.
 */
export function resortPlaceholder<T extends PagedResult>(
  list: unknown,
  sort: string | undefined,
  cursor: string | null | undefined,
): ResortPlaceholderOptions<T> {
  const resortList = JSON.stringify(list ?? null);
  const resortSort = sort ?? null;
  return {
    meta: { resortList, resortSort },
    placeholderData: (previous, previousQuery) => {
      const prev = previousQuery?.meta as ResortMeta | undefined;
      if (!previous || cursor || prev?.resortList !== resortList || prev.resortSort === resortSort) {
        return undefined;
      }
      if (!previous.pagination) return previous;
      return { ...previous, pagination: { ...previous.pagination, cursor: null, has_more: false } };
    },
  };
}

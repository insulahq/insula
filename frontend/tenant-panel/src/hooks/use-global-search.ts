import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/hooks/use-auth';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { SEARCH_MIN_QUERY_LENGTH, type SearchGroup, type SearchResponse } from '@insula/api-contracts';
import { TENANT_SEARCH_REGISTRY } from '@/search/registry';
import { searchRegistry, type StaticHit } from '@/search/match';

/**
 * 250 ms. Long enough that a normal typing burst produces one request
 * rather than one per character — which matters because the endpoint has
 * its own 120/min budget — and short enough that the dropdown still feels
 * like it is keeping up.
 */
const DEBOUNCE_MS = 250;

/** Page/tab hits shown before the record groups. More than this and the record groups fall below the fold. */
const STATIC_LIMIT = 6;

export interface GlobalSearchResult {
  /** Page and tab hits. Computed locally, so these are present immediately. */
  readonly staticHits: readonly StaticHit[];
  /** Record hits from the API. Empty until the debounced query resolves. */
  readonly groups: readonly SearchGroup[];
  /** True while a record query is in flight for the CURRENT term. */
  readonly isLoadingRecords: boolean;
  /**
   * Set when the record query failed. The dropdown says so explicitly
   * rather than rendering "No results" — an outage that looks like an
   * empty estate is the worse of the two failures.
   */
  readonly recordsError: boolean;
  /** True once the term is long enough to have asked the API anything. */
  readonly isQueryable: boolean;
}

export function useGlobalSearch(rawQuery: string): GlobalSearchResult {
  const role = useAuth((s) => s.user?.role);
  const query = rawQuery.trim();
  const debounced = useDebouncedValue(query, DEBOUNCE_MS);

  // Static hits track the RAW query, not the debounced one: they cost a
  // synchronous array scan, so making the user wait 250 ms for them would
  // be latency for nothing.
  const staticHits = useMemo(
    () => searchRegistry(TENANT_SEARCH_REGISTRY, query, role, STATIC_LIMIT),
    [query, role],
  );

  const isQueryable = debounced.length >= SEARCH_MIN_QUERY_LENGTH;

  const { data, isFetching, isError } = useQuery({
    queryKey: ['global-search', debounced],
    enabled: isQueryable,
    // Results are a live view of the estate; a stale dropdown is
    // confusing, but re-fetching the same term within a few seconds
    // (backspace then retype) is pure waste.
    staleTime: 10_000,
    retry: false,
    queryFn: ({ signal }) =>
      apiFetch<{ data: SearchResponse }>(
        `/api/v1/search?q=${encodeURIComponent(debounced)}`,
        // Cancels the in-flight request when the term changes, so a slow
        // response for "acm" cannot land after "acme" and overwrite it.
        { signal },
      ),
  });

  return {
    staticHits,
    groups: data?.data.groups ?? [],
    // `isFetching` alone is true before `enabled` flips, which renders a
    // spinner on a one-character query that will never be sent.
    isLoadingRecords: isQueryable && isFetching,
    recordsError: isQueryable && isError,
    isQueryable,
  };
}

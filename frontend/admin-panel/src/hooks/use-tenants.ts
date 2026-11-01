import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { resortPlaceholder } from '@/hooks/resort-placeholder';
import type { Tenant, PaginatedResponse } from '@/types/api';
import { MAX_PAGE_LIMIT, type CreateTenantInput, type UpdateTenantInput, type CreateTenantResponse, type TenantListFilters } from '@insula/api-contracts';

interface ListTenantsParams {
  readonly search?: string;
  readonly limit?: number;
  readonly cursor?: string;
  /** Every tenant, read page by page — the list's "All" rows-per-page. */
  readonly all?: boolean;
  /**
   * `field:asc|desc` — the server orders (and pages) the whole list by it.
   * A cursor belongs to the sort it was made under: change one, drop the other.
   */
  readonly sort?: string;
  /** The page's "Filter by": narrows the list and its total on the server. */
  readonly filters?: TenantListFilters;
}

function tenantsPath(
  search: string | undefined,
  limit: number | undefined,
  cursor: string | undefined,
  sort: string | undefined,
  filters: TenantListFilters = {},
): string {
  const searchParams = new URLSearchParams();
  if (search) searchParams.set('search', search);
  for (const [key, value] of Object.entries(filters)) {
    if (value) searchParams.set(key, value);
  }
  if (limit) searchParams.set('limit', String(limit));
  if (cursor) searchParams.set('cursor', cursor);
  if (sort) searchParams.set('sort', sort);
  const qs = searchParams.toString();
  return `/api/v1/tenants${qs ? `?${qs}` : ''}`;
}

/** A runaway cursor stops here: 100 pages of 100 is far past the platform's size. */
const MAX_PAGES_FOR_ALL = 100;

/**
 * Every tenant matching `search`, as one page, in the server's `sort` order.
 * The API caps a page at MAX_PAGE_LIMIT, so "All" follows the cursor rather
 * than asking for a bigger page the API would refuse.
 */
export async function fetchAllTenants(
  search: string | undefined,
  sort?: string,
  filters?: TenantListFilters,
): Promise<PaginatedResponse<Tenant>> {
  const rows: Tenant[] = [];
  let cursor: string | undefined;
  let total = 0;
  let more = false;
  for (let page = 0; page < MAX_PAGES_FOR_ALL; page += 1) {
    const res = await apiFetch<PaginatedResponse<Tenant>>(tenantsPath(search, MAX_PAGE_LIMIT, cursor, sort, filters));
    rows.push(...res.data);
    total = res.pagination?.total_count ?? rows.length;
    more = Boolean(res.pagination?.has_more && res.pagination.cursor);
    if (!more) break;
    cursor = res.pagination.cursor ?? undefined;
  }
  // Cut off at the page cap, the list says so: the total stays the server's
  // and has_more stays true, rather than presenting what was read as all.
  return { data: rows, pagination: { total_count: more ? total : rows.length, cursor: null, has_more: more, page_size: rows.length } };
}

export function useTenants(params: ListTenantsParams = {}) {
  return useQuery({
    queryKey: ['tenants', params],
    queryFn: () => (params.all
      ? fetchAllTenants(params.search, params.sort, params.filters)
      : apiFetch<PaginatedResponse<Tenant>>(tenantsPath(params.search, params.limit, params.cursor, params.sort, params.filters))),
    // A live column (CPU, memory, …) and "All" rows per page read the whole
    // list, a live column in name order: switching to or from either changes
    // the rows on screen as a sort does, so the old ones stay until it lands.
    ...resortPlaceholder<PaginatedResponse<Tenant>>(
      { search: params.search, filters: params.filters },
      `${params.all ? 'all ' : ''}${params.sort ?? ''}`,
      params.cursor,
    ),
  });
}

export function useTenant(id: string | undefined) {
  return useQuery({
    queryKey: ['tenants', id],
    queryFn: () => apiFetch<{ data: Tenant }>(`/api/v1/tenants/${id}`),
    enabled: !!id,
    // Poll every 3s while provisioning is in progress (stops once provisioned/failed)
    refetchInterval: (query) => {
      const status = (query.state.data?.data as Record<string, unknown> | undefined)?.provisioningStatus;
      return (status === 'provisioning' || status === 'unprovisioned') ? 3000 : false;
    },
  });
}

export function useCreateTenant() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateTenantInput) =>
      apiFetch<{ data: CreateTenantResponse }>('/api/v1/tenants', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tenants'] });
    },
  });
}

export function useUpdateTenant(id: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateTenantInput) =>
      apiFetch<{ data: Tenant }>(`/api/v1/tenants/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tenants'] });
      queryClient.invalidateQueries({ queryKey: ['tenants', id] });
    },
  });
}

export function useDeleteTenant() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: { transitionId: string | null } }>(`/api/v1/tenants/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tenants'] });
      // It is now a DELETED tenant with retained bundles — recoverable, by name.
      queryClient.invalidateQueries({ queryKey: ['recoverable-tenants'] });
    },
  });
}

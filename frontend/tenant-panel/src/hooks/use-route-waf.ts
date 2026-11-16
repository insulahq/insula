/**
 * A route's WAF events and trusted IPs. The event list is filtered, sorted
 * and paged by the server (waf-logs/route-events.ts) — sorting the rows a
 * page happens to hold would order a page, not the log.
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateWafTrustedIpRequest,
  RouteWafLogEntry,
  RouteWafLogOutcome,
  RouteWafLogSortField,
  WafLogSourcesResponse,
  WafTrustedIp,
  WafTrustedIpListResponse,
} from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';

const routeBase = (tenantId: string, routeId: string) => `/api/v1/tenants/${tenantId}/routes/${routeId}`;

export interface RouteWafLogFilters {
  readonly sourceIp?: string;
  readonly ruleId?: string;
  readonly path?: string;
  readonly outcome: RouteWafLogOutcome;
}

export interface RouteWafLogSort {
  readonly field: RouteWafLogSortField;
  readonly direction: 'asc' | 'desc';
}

interface RouteWafLogPage {
  readonly data: readonly RouteWafLogEntry[];
  readonly pagination: { readonly cursor: string | null; readonly has_more: boolean; readonly total_count: number };
}

export const ROUTE_WAF_LOG_PAGE_SIZE = 50;

export function useRouteWafLogPages(
  tenantId: string | undefined,
  routeId: string | undefined,
  filters: RouteWafLogFilters,
  sort: RouteWafLogSort,
) {
  return useInfiniteQuery({
    queryKey: ['route-waf-logs', tenantId, routeId, filters, sort],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: String(ROUTE_WAF_LOG_PAGE_SIZE), sort: `${sort.field}:${sort.direction}`, outcome: filters.outcome });
      if (filters.sourceIp) q.set('sourceIp', filters.sourceIp);
      if (filters.ruleId) q.set('ruleId', filters.ruleId);
      if (filters.path) q.set('path', filters.path);
      if (pageParam) q.set('cursor', pageParam);
      return apiFetch<RouteWafLogPage>(`${routeBase(tenantId!, routeId!)}/waf-logs?${q.toString()}`);
    },
    getNextPageParam: (last) => (last.pagination?.has_more ? last.pagination.cursor : null),
    enabled: Boolean(tenantId && routeId),
  });
}

/** The route's WAF events by source address, for the last `sinceSeconds`. */
export function useRouteWafLogSources(tenantId: string | undefined, routeId: string | undefined, sinceSeconds: number) {
  return useQuery({
    queryKey: ['route-waf-log-sources', tenantId, routeId, sinceSeconds],
    queryFn: () =>
      apiFetch<{ data: WafLogSourcesResponse }>(
        `${routeBase(tenantId!, routeId!)}/waf-logs/sources?sinceSeconds=${sinceSeconds}`,
      ),
    enabled: Boolean(tenantId && routeId),
  });
}

export function useRouteWafTrustedIps(tenantId: string | undefined, routeId: string | undefined) {
  return useQuery({
    queryKey: ['route-waf-trusted-ips', tenantId, routeId],
    queryFn: () => apiFetch<{ data: WafTrustedIpListResponse }>(`${routeBase(tenantId!, routeId!)}/waf-trusted-ips`),
    enabled: Boolean(tenantId && routeId),
  });
}

export function useCreateRouteWafTrustedIp(tenantId: string | undefined, routeId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWafTrustedIpRequest) =>
      apiFetch<{ data: WafTrustedIp }>(`${routeBase(tenantId!, routeId!)}/waf-trusted-ips`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['route-waf-trusted-ips', tenantId, routeId] });
      queryClient.invalidateQueries({ queryKey: ['route-waf-log-sources', tenantId, routeId] });
    },
  });
}

export function useDeleteRouteWafTrustedIp(tenantId: string | undefined, routeId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: { deleted: true } }>(`${routeBase(tenantId!, routeId!)}/waf-trusted-ips/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['route-waf-trusted-ips', tenantId, routeId] });
      queryClient.invalidateQueries({ queryKey: ['route-waf-log-sources', tenantId, routeId] });
    },
  });
}

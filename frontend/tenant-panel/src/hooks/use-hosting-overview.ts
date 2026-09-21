import { useQuery } from '@tanstack/react-query';
import type { TenantDashboardSummary, TenantDashboardLive } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';

/**
 * Two polls, same split as the operator console: the cheap half from the
 * platform database every 30s, the live half (resource metrics, sites) every
 * two minutes. Both pause while the tab is hidden, so a dashboard left open
 * overnight stops reading the cluster for nobody.
 */
const FAST_MS = 30_000;
const SLOW_MS = 120_000;

const intervalWhenVisible = (ms: number) => () =>
  (typeof document !== 'undefined' && document.hidden ? false : ms);

export function useOverviewSummary(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['hosting-overview', 'summary', tenantId],
    enabled: Boolean(tenantId),
    queryFn: () => apiFetch<{ data: TenantDashboardSummary }>(
      `/api/v1/tenants/${tenantId}/dashboard/summary`),
    refetchInterval: intervalWhenVisible(FAST_MS),
    staleTime: FAST_MS,
    refetchOnWindowFocus: true,
    // One retry: a rate-limited dashboard must not hammer its way further
    // into the limit that produced the 429.
    retry: 1,
  });
}

export function useOverviewLive(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['hosting-overview', 'live', tenantId],
    enabled: Boolean(tenantId),
    queryFn: () => apiFetch<{ data: TenantDashboardLive }>(
      `/api/v1/tenants/${tenantId}/dashboard/live`),
    refetchInterval: intervalWhenVisible(SLOW_MS),
    staleTime: SLOW_MS,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

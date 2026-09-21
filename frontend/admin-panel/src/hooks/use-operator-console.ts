import { useQuery } from '@tanstack/react-query';
import type { AdminDashboardSummary, AdminDashboardLive } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';

/**
 * Two polls, not twenty-three.
 *
 * The fast half is database-only and refreshes on the same 30s cadence the
 * server caches it for; the slow half leaves the API for the kube cluster and
 * refreshes every two minutes. Aligning the client interval with the server
 * TTL means a poll either hits a warm cache or refills one — never both.
 *
 * Both pause while the tab is hidden. Without that a dashboard left open
 * overnight keeps reading the kube API until morning for nobody.
 */

const FAST_MS = 30_000;
const SLOW_MS = 120_000;

/** `false` stops TanStack Query polling; it resumes on the next visible tick. */
function intervalWhenVisible(ms: number) {
  return () => (typeof document !== 'undefined' && document.hidden ? false : ms);
}

export function useConsoleSummary() {
  return useQuery({
    queryKey: ['operator-console', 'summary'],
    queryFn: () => apiFetch<{ data: AdminDashboardSummary }>('/api/v1/admin/dashboard/summary'),
    refetchInterval: intervalWhenVisible(FAST_MS),
    staleTime: FAST_MS,
    // A dashboard is worth re-reading when you come back to it.
    refetchOnWindowFocus: true,
    // One retry only: a rate-limited dashboard must not hammer its way
    // further into the limit that produced the 429.
    retry: 1,
  });
}

export function useConsoleLive() {
  return useQuery({
    queryKey: ['operator-console', 'live'],
    queryFn: () => apiFetch<{ data: AdminDashboardLive }>('/api/v1/admin/dashboard/live'),
    refetchInterval: intervalWhenVisible(SLOW_MS),
    staleTime: SLOW_MS,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

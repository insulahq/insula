import { useQuery } from '@tanstack/react-query';
import type { ApplicationUsage } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';
import { DEPLOYMENT_POLL_IDLE_MS } from '@/lib/deployment-polling';

/**
 * The subscription's application limit and how much of it is used — what the
 * Applications page pill, the deploy buttons and Settings show.
 *
 * Keyed under ['deployments', tenantId] so every deploy, delete and restore
 * mutation that already invalidates the deployment list refreshes it too.
 */
export const applicationUsageKey = (tenantId: string | undefined) => ['deployments', tenantId, 'application-usage'] as const;

export function useApplicationUsage(tenantId: string | undefined) {
  return useQuery({
    queryKey: applicationUsageKey(tenantId),
    queryFn: () => apiFetch<{ data: ApplicationUsage }>(`/api/v1/tenants/${tenantId}/applications/usage`),
    enabled: Boolean(tenantId),
    // Re-read like the application lists do: an application added or removed
    // anywhere but this panel (the API, an operator, another tab) otherwise
    // left the pill on the old count until a reload.
    refetchInterval: DEPLOYMENT_POLL_IDLE_MS,
    select: (r) => r.data,
  });
}

/** Room for one more? Unknown (still loading, or unreadable) is room: the API still refuses. Pure. */
export function applicationRoom(usage: ApplicationUsage | undefined): { readonly atLimit: boolean; readonly over: boolean } {
  if (!usage) return { atLimit: false, over: false };
  return { atLimit: usage.current >= usage.limit, over: usage.current > usage.limit };
}

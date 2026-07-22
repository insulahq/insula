/**
 * Tenant-panel monthly-bandwidth usage hook.
 *
 * Backend endpoint: `GET /api/v1/tenants/:id/bandwidth` — tenant-readable
 * (requireTenantAccess), month-to-date egress vs the effective limit + cap state.
 */

import { useQuery } from '@tanstack/react-query';
import type { TenantBandwidthUsage } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';
import { useTenantContext } from '@/hooks/use-tenant-context';

export type { TenantBandwidthUsage } from '@insula/api-contracts';

export function useBandwidth() {
  const { tenantId } = useTenantContext();
  return useQuery({
    queryKey: ['bandwidth', tenantId],
    queryFn: () => apiFetch<{ data: TenantBandwidthUsage }>(`/api/v1/tenants/${tenantId}/bandwidth`),
    enabled: Boolean(tenantId),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000, // bandwidth is metered hourly — no need to poll fast
  });
}

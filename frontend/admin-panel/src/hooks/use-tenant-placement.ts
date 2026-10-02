import { useQuery } from '@tanstack/react-query';
import type { TenantPlacementDetailResponse } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';

/**
 * Where a tenant actually runs and keeps its data versus its primary node, and
 * its recent storage failovers. Served from the placement reconciler's last
 * observation (every minute), so polling faster than that shows nothing new.
 */
export function useTenantPlacement(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['tenant-placement', tenantId],
    queryFn: () => apiFetch<TenantPlacementDetailResponse>(`/api/v1/tenants/${tenantId}/placement`),
    enabled: !!tenantId,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

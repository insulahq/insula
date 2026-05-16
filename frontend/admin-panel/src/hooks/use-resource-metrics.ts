import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface ResourceMetrics {
  readonly tenantId: string;
  readonly cpu: { readonly inUse: number; readonly reserved: number; readonly available: number };
  readonly memory: { readonly inUse: number; readonly reserved: number; readonly available: number };
  readonly storage: { readonly inUse: number; readonly reserved: number; readonly available: number };
  readonly lastUpdatedAt: string;
}

// Bulk fetch metrics for all tenants shown in list
export function useAllTenantMetrics(tenantIds: readonly string[]) {
  return useQuery({
    queryKey: ['all-tenant-metrics', ...tenantIds],
    queryFn: () => apiFetch<{ data: Record<string, ResourceMetrics | null> }>(
      `/api/v1/admin/tenants/resource-metrics?ids=${tenantIds.join(',')}`
    ),
    enabled: tenantIds.length > 0,
    staleTime: 60_000,
  });
}

export function useTenantMetrics(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['tenant-metrics', tenantId],
    queryFn: () => apiFetch<{ data: ResourceMetrics }>(`/api/v1/tenants/${tenantId}/resource-metrics`),
    enabled: Boolean(tenantId),
    staleTime: 60_000,
  });
}

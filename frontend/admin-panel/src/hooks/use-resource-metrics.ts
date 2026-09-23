import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

/**
 * Hand-written mirror of the backend's shape. The backend computes every field
 * as a number, but this type is a CLAIM about a wire format, not a guarantee —
 * and a null reached the tenant table and crashed the page on `.toFixed()`.
 * The numeric fields are therefore typed nullable, so every consumer is forced
 * to decide what a missing reading renders as.
 */
interface MetricTriple {
  readonly inUse: number | null;
  readonly reserved: number | null;
  readonly available: number | null;
}

export interface ResourceMetrics {
  readonly tenantId: string;
  readonly cpu: MetricTriple;
  readonly memory: MetricTriple;
  readonly storage: MetricTriple;
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

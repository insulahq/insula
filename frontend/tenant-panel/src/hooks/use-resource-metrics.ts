import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useTenantContext } from '@/hooks/use-tenant-context';

export interface ResourceMetrics {
  readonly tenantId: string;
  readonly cpu: { readonly inUse: number; readonly reserved: number; readonly available: number };
  readonly memory: { readonly inUse: number; readonly reserved: number; readonly available: number };
  readonly storage: { readonly inUse: number; readonly reserved: number; readonly available: number };
  readonly lastUpdatedAt: string;
}

export function useResourceMetrics() {
  const { tenantId } = useTenantContext();
  return useQuery({
    queryKey: ['resource-metrics', tenantId],
    queryFn: () => apiFetch<{ data: ResourceMetrics }>(`/api/v1/tenants/${tenantId}/resource-metrics`),
    enabled: Boolean(tenantId),
    staleTime: 60_000,
    refetchInterval: 60_000, // Auto-refresh every 60 seconds
  });
}

export function useRefreshMetrics() {
  const { tenantId } = useTenantContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ data: ResourceMetrics }>(`/api/v1/tenants/${tenantId}/resource-metrics/refresh`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resource-metrics', tenantId] });
    },
  });
}

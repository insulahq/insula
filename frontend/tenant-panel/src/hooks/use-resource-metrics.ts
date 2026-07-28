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
    // Live view: poll every 60s while the operator is actually looking at the
    // page, and refresh immediately when they come back to the tab. The server
    // collects from the cluster on demand (it only serves a cached sample for
    // ~15s, purely to coalesce concurrent viewers), so each poll is current.
    refetchInterval: 60_000,
    // Explicit: no polling while the tab is hidden. A backgrounded panel should
    // not keep the API listing pods for every tenant it has open.
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
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

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface ResourceAvailability {
  readonly cpuLimit: number;
  readonly memoryLimitGi: number;
  readonly storageLimitGi: number;
  readonly cpuUsed: number;
  readonly memoryUsedGi: number;
  readonly storageUsedGi: number;
  readonly cpuAvailable: number;
  readonly memoryAvailableGi: number;
  readonly storageAvailableGi: number;
}

export type { ResourceAvailability };

export function useResourceAvailability(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['resource-availability', tenantId],
    queryFn: () => apiFetch<{ data: ResourceAvailability }>(
      `/api/v1/tenants/${tenantId}/resource-availability`
    ),
    enabled: Boolean(tenantId),
    staleTime: 30_000,
  });
}

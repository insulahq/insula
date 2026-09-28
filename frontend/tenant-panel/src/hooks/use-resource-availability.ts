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
  /**
   * ★ Which CPU model governs this tenant (ADR-062).
   *
   * Under `tiered` a tenant does not choose a CPU number — their
   * applications take `cpuTier` and are bounded by `cpuBurstCores` — so
   * every surface that offers a millicore box, gates a deploy on a CPU
   * reservation, or prints "used / reserved" has to ask this first.
   *
   * Optional so the panel keeps working against an API that predates it.
   */
  readonly cpuModel?: 'legacy' | 'tiered';
  readonly cpuTier?: 'normal' | 'high' | 'highest' | null;
  readonly cpuBurstCores?: number | null;
  readonly cpuTierRequest?: string | null;
}

/** Tenant-facing labels for the three shares. */
export const CPU_TIER_LABEL: Record<'normal' | 'high' | 'highest', string> = {
  normal: 'Normal',
  high: 'High',
  highest: 'Highest',
};

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

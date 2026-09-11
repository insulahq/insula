import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  ClusterOutageImpact,
  TenantHealthEntry,
  TenantHealthFinding,
  TenantHealthState,
} from '@insula/api-contracts';

export type { ClusterOutageImpact, TenantHealthEntry, TenantHealthFinding, TenantHealthState };

interface OutageImpactEnvelope {
  readonly data: ClusterOutageImpact;
}

/**
 * Which nodes are down and which tenants that affects.
 *
 * Polled from the global layout, so every admin page can surface an outage
 * the moment it is detected rather than only the Cluster Nodes page. Added
 * after the 2026-09-11 drill, where the dashboard showed "Platform: Healthy"
 * throughout a real node outage.
 *
 * 20 s: the backend caches for 15 s, so this is roughly one cluster read per
 * poll interval no matter how many operators have a tab open.
 */
export function useOutageImpact() {
  return useQuery({
    queryKey: ['cluster', 'outage-impact'],
    queryFn: () => apiFetch<OutageImpactEnvelope>('/api/v1/admin/cluster/outage-impact'),
    refetchInterval: 20_000,
  });
}

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { HostMigrationStatusResponse } from '@insula/api-contracts';

/**
 * Per-node host-migration state. Polled rather than fetched once: the data is
 * republished by each node's converge, so a fix an operator applies on the host
 * shows up here without a manual reload.
 */
export function useHostMigrationStatus(enabled = true) {
  return useQuery({
    queryKey: ['host-migrations-status'],
    queryFn: () =>
      apiFetch<{ data: HostMigrationStatusResponse }>('/api/v1/admin/platform/host-migrations/status'),
    enabled,
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
}

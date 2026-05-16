import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { Backup, PaginatedResponse } from '@/types/api';

export function useBackups(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['backups', tenantId],
    queryFn: () =>
      apiFetch<PaginatedResponse<Backup>>(
        `/api/v1/tenants/${tenantId}/backups`,
      ),
    enabled: Boolean(tenantId),
  });
}

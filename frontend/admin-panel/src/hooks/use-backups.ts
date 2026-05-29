import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { PaginatedResponse } from '@/types/api';
import type { BackupResponse } from '@insula/api-contracts';

export type { BackupResponse as Backup } from '@insula/api-contracts';

export function useBackups(tenantId: string | undefined) {
  const path = `/api/v1/tenants/${tenantId}/backups`;

  return useQuery({
    queryKey: ['backups', tenantId],
    queryFn: () => apiFetch<PaginatedResponse<BackupResponse>>(path),
    enabled: !!tenantId,
  });
}

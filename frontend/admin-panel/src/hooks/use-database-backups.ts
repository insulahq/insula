import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { AdminDatabaseBackupStatusList } from '@insula/api-contracts';

/**
 * The last attempt and the last good backup of each of a tenant's databases,
 * as recorded after every bundle (`database_backup_status`).
 */
export function useTenantDatabaseBackups(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'database-backups', tenantId],
    queryFn: () => {
      if (!tenantId) throw new Error('No tenant id');
      return apiFetch<{ data: AdminDatabaseBackupStatusList }>(
        `/api/v1/admin/tenants/${encodeURIComponent(tenantId)}/database-backups`,
      );
    },
    enabled: Boolean(tenantId),
    staleTime: 30_000,
  });
}

/** Every overdue database backup across tenants. */
export function useOverdueDatabaseBackups() {
  return useQuery({
    queryKey: ['admin', 'database-backups', 'overdue'],
    queryFn: () => apiFetch<{ data: AdminDatabaseBackupStatusList }>('/api/v1/admin/database-backups/overdue'),
    staleTime: 60_000,
  });
}

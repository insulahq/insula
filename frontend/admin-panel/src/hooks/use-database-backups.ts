import { useInfiniteQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { AdminDatabaseBackupStatus, PaginationMeta } from '@insula/api-contracts';

interface Page {
  readonly data: readonly AdminDatabaseBackupStatus[];
  readonly pagination: PaginationMeta;
}

function pagedQuery(queryKey: readonly unknown[], path: string, enabled = true) {
  return {
    queryKey,
    queryFn: ({ pageParam }: { pageParam: string | null }) => apiFetch<Page>(
      pageParam ? `${path}?cursor=${encodeURIComponent(pageParam)}` : path,
    ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Page) => (last.pagination?.has_more ? last.pagination.cursor : null),
    enabled,
  };
}

/**
 * The last attempt and the last good backup of each of a tenant's databases,
 * as recorded after every bundle (`database_backup_status`), a page at a time.
 */
export function useTenantDatabaseBackups(tenantId: string | undefined) {
  return useInfiniteQuery({
    ...pagedQuery(['admin', 'database-backups', tenantId], `/api/v1/admin/tenants/${encodeURIComponent(tenantId ?? '')}/database-backups`, Boolean(tenantId)),
    staleTime: 30_000,
  });
}

/** Every overdue database backup across tenants, a page at a time. */
export function useOverdueDatabaseBackups() {
  return useInfiniteQuery({
    ...pagedQuery(['admin', 'database-backups', 'overdue'], '/api/v1/admin/database-backups/overdue'),
    staleTime: 60_000,
  });
}

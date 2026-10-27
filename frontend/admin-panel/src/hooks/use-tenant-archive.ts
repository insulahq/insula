import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RestoreArchivedTenantRequest, TenantArchiveInfo } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';

/** An archived tenant's archive bundle, its expiry, and whether it can be restored. */
export function useTenantArchive(tenantId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['tenant-archive', tenantId],
    queryFn: () => apiFetch<{ data: TenantArchiveInfo }>(`/api/v1/admin/tenants/${tenantId}/archive`),
    enabled: Boolean(tenantId) && enabled,
  });
}

/**
 * Restore an archived tenant from its archive, on the node and at the size the
 * dialog chose. It comes back suspended. Answers with the storage operation to
 * follow.
 */
export function useRestoreArchivedTenant(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RestoreArchivedTenantRequest) =>
      apiFetch<{ data: { operationId: string; snapshotId: string } }>(`/api/v1/admin/tenants/${tenantId}/storage/restore`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      for (const queryKey of [['tenants'], ['tenant-archive', tenantId], ['storage-operations', tenantId]]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}

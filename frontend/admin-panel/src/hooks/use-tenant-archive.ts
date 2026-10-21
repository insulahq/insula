import { useQuery } from '@tanstack/react-query';
import type { TenantArchiveInfo } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';

/** An archived tenant's archive bundle, its expiry, and whether it can be restored. */
export function useTenantArchive(tenantId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['tenant-archive', tenantId],
    queryFn: () => apiFetch<{ data: TenantArchiveInfo }>(`/api/v1/admin/tenants/${tenantId}/archive`),
    enabled: Boolean(tenantId) && enabled,
  });
}

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

/**
 * Browse a TENANT's storage from the admin panel.
 *
 * Read-only on purpose: the admin panel needs this to pick the folder a
 * hostname serves on a multi-host deployment, and nothing more. Creating or
 * writing files on a tenant's behalf is the file manager's job, in the tenant
 * panel, where the tenant can see what happened.
 */
export interface TenantFileEntry {
  readonly name: string;
  readonly type: 'file' | 'directory';
}

interface TenantDirectoryListing {
  readonly path: string;
  readonly entries: readonly TenantFileEntry[];
}

export function useTenantDirectoryListing(
  tenantId: string | undefined,
  path: string,
  enabled = true,
) {
  return useQuery({
    queryKey: ['admin-tenant-files', tenantId, path],
    queryFn: () => apiFetch<{ data: TenantDirectoryListing }>(
      `/api/v1/tenants/${tenantId}/files?path=${encodeURIComponent(path)}`,
    ),
    select: (res) => res.data,
    enabled: enabled && Boolean(tenantId),
  });
}

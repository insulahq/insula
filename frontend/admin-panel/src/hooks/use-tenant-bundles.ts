import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { BundleSummary, PaginationMeta } from '@insula/api-contracts';

interface BundleListEnvelope {
  readonly data: readonly BundleSummary[];
  readonly pagination?: PaginationMeta;
}

/**
 * Off-site backup bundles (`backup_jobs`) for ONE tenant — the platform's only
 * record of a tenant actually being backed up.
 *
 * Replaces the admin panel's old `useBackups()`, which read the retired
 * per-resource `backups` table. Nothing but that table's own CRUD API ever
 * wrote a row there, so the Backups tab showed an empty table (and a `0` count)
 * for tenants with dozens of bundles.
 */
export function useTenantBundles(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'tenant-bundles', tenantId],
    queryFn: () => {
      if (!tenantId) throw new Error('No tenant id');
      return apiFetch<BundleListEnvelope>(
        `/api/v1/admin/tenant-bundles?tenantId=${encodeURIComponent(tenantId)}`,
      );
    },
    enabled: Boolean(tenantId),
    staleTime: 15_000,
  });
}

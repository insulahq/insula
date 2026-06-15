/**
 * Tenant-panel hooks for on-server volume snapshots
 * (/api/v1/tenants/:tenantId/snapshots). These are short-term, on-server
 * PVC recovery points that auto-expire — NOT backups (those are the Backups
 * page). The list response also carries the admin-configured retention so the
 * UI can show "auto-deletes after N hours".
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/hooks/use-auth';
import type { TenantSnapshot, ListTenantSnapshotsResponse } from '@insula/api-contracts';

interface ListResponse { readonly data: ListTenantSnapshotsResponse }
interface CreateResponse { readonly data: TenantSnapshot }

export function useSnapshots() {
  const tenantId = useAuth((s) => s.user?.tenantId);
  return useQuery({
    queryKey: ['tenant-snapshots', tenantId],
    queryFn: () => {
      if (!tenantId) throw new Error('No tenant id on session');
      return apiFetch<ListResponse>(`/api/v1/tenants/${tenantId}/snapshots`);
    },
    enabled: Boolean(tenantId),
    // Poll while any snapshot is still creating so the row flips to ready
    // (the server reconciles status from the live VolumeSnapshot on list).
    refetchInterval: (query) => {
      const snaps = query.state.data?.data?.snapshots ?? [];
      return snaps.some((s) => s.status === 'creating') ? 3000 : false;
    },
  });
}

export function useCreateSnapshot() {
  const qc = useQueryClient();
  const tenantId = useAuth((s) => s.user?.tenantId);
  return useMutation({
    mutationFn: (label?: string) => {
      if (!tenantId) throw new Error('No tenant id on session');
      return apiFetch<CreateResponse>(`/api/v1/tenants/${tenantId}/snapshots`, {
        method: 'POST',
        body: JSON.stringify(label && label.trim() ? { label: label.trim() } : {}),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenant-snapshots', tenantId] }),
  });
}

export function useDeleteSnapshot() {
  const qc = useQueryClient();
  const tenantId = useAuth((s) => s.user?.tenantId);
  return useMutation({
    mutationFn: (snapshotId: string) => {
      if (!tenantId) throw new Error('No tenant id on session');
      return apiFetch<void>(`/api/v1/tenants/${tenantId}/snapshots/${snapshotId}`, {
        method: 'DELETE',
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenant-snapshots', tenantId] }),
  });
}

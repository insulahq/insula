/**
 * Admin-panel hooks for a tenant's on-server Longhorn volume snapshots
 * (/api/v1/tenants/:tenantId/snapshots). Same endpoints the tenant panel
 * uses — operator (admin) tokens are authorized for any tenant by the
 * route's requireTenantAccess gate, so no separate /admin/* surface is
 * needed. These are local PVC recovery points (Longhorn CSI), NOT the
 * off-site restic tenant bundles on the Backups tab.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  TenantSnapshot,
  ListTenantSnapshotsResponse,
  StartSnapshotRestoreResponse,
  SnapshotRestoreStatus,
} from '@insula/api-contracts';

interface ListResponse { readonly data: ListTenantSnapshotsResponse }
interface CreateResponse { readonly data: TenantSnapshot }

const listKey = (tenantId: string) => ['admin-tenant-snapshots', tenantId];

export function useTenantSnapshots(tenantId: string) {
  return useQuery({
    queryKey: listKey(tenantId),
    queryFn: () => apiFetch<ListResponse>(`/api/v1/tenants/${tenantId}/snapshots`),
    enabled: Boolean(tenantId),
    // Poll while any snapshot is mid-transition so the row flips to its
    // terminal state (the server reconciles status from the live
    // VolumeSnapshot on list).
    refetchInterval: (query) => {
      const snaps = query.state.data?.data?.snapshots ?? [];
      return snaps.some((s) => s.status === 'creating' || s.status === 'deleting') ? 3000 : false;
    },
  });
}

export function useCreateTenantSnapshot(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (label?: string) =>
      apiFetch<CreateResponse>(`/api/v1/tenants/${tenantId}/snapshots`, {
        method: 'POST',
        body: JSON.stringify(label && label.trim() ? { label: label.trim() } : {}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey(tenantId) }),
  });
}

export function useDeleteTenantSnapshot(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (snapshotId: string) =>
      apiFetch<void>(`/api/v1/tenants/${tenantId}/snapshots/${snapshotId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey(tenantId) }),
  });
}

/** Start a DESTRUCTIVE in-place revert. Resolves with the storage operation id to poll. */
export function useRestoreTenantSnapshot(tenantId: string) {
  return useMutation({
    mutationFn: (snapshotId: string) =>
      apiFetch<{ data: StartSnapshotRestoreResponse }>(
        `/api/v1/tenants/${tenantId}/snapshots/${snapshotId}/restore`,
        { method: 'POST' },
      ),
  });
}

/** Poll a restore operation. Stops polling once the op is idle/failed. */
export function useTenantRestoreStatus(tenantId: string, operationId: string | null) {
  return useQuery({
    queryKey: ['admin-snapshot-restore', tenantId, operationId],
    queryFn: () => {
      if (!operationId) throw new Error('operationId is required');
      return apiFetch<{ data: SnapshotRestoreStatus }>(
        `/api/v1/tenants/${tenantId}/snapshots/restore-status/${operationId}`,
      );
    },
    enabled: Boolean(tenantId && operationId),
    refetchInterval: (query) => {
      const st = query.state.data?.data?.state;
      return st && st !== 'idle' && st !== 'failed' ? 2000 : false;
    },
  });
}

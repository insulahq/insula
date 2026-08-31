import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { TrashListResponse, TrashPurgeResult, TrashRestoreResult } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';
import { useTenantContext } from '@/hooks/use-tenant-context';
import { reportFileManagerError } from '@/hooks/use-file-manager-errors';

/**
 * Recycle-bin queries.
 *
 * Every mutation invalidates `disk-usage` as well as the bin itself: the trash
 * lives on the tenant's own PVC, so restoring or purging changes the storage
 * readout, and leaving a stale figure on screen would undercut the one signal
 * the tenant has about what the bin is costing them.
 */

export function useTrash(enabled = true) {
  const { tenantId } = useTenantContext();
  return useQuery({
    queryKey: ['file-trash', tenantId],
    queryFn: () => apiFetch<{ data: TrashListResponse }>(`/api/v1/tenants/${tenantId}/files/trash`),
    select: (res) => res.data,
    enabled: enabled && Boolean(tenantId),
  });
}

export function useRestoreFromTrash() {
  const { tenantId } = useTenantContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, overwrite, autoRename }: { id: string; overwrite?: boolean; autoRename?: boolean }) =>
      apiFetch<{ data: TrashRestoreResult }>(`/api/v1/tenants/${tenantId}/files/trash/restore`, {
        method: 'POST',
        body: JSON.stringify({ id, overwrite: overwrite === true, autoRename: autoRename === true }),
      }),
    // A 409 conflict is an expected outcome the dialog handles inline, not a
    // banner-worthy failure — the caller decides. Errors still reach the shared
    // banner so a genuine failure is never silent.
    onError: (err) => { reportFileManagerError(err); },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['file-trash', tenantId] });
      qc.invalidateQueries({ queryKey: ['files', tenantId] });
      qc.invalidateQueries({ queryKey: ['disk-usage', tenantId] });
    },
  });
}

export function usePurgeTrash() {
  const { tenantId } = useTenantContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, all }: { ids?: string[]; all?: boolean }) =>
      apiFetch<{ data: TrashPurgeResult }>(`/api/v1/tenants/${tenantId}/files/trash/purge`, {
        method: 'POST',
        body: JSON.stringify(all ? { all: true } : { ids }),
      }),
    onError: (err) => { reportFileManagerError(err); },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['file-trash', tenantId] });
      qc.invalidateQueries({ queryKey: ['disk-usage', tenantId] });
    },
  });
}

/** Whole days until an entry is purged; 0 means "today". */
export function daysUntilPurge(deletedAt: string, retentionDays: number): number {
  const expiresAt = Date.parse(deletedAt) + retentionDays * 86_400_000;
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 86_400_000));
}

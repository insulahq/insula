import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  OrphanedVolumesReport,
  OrphanSnapshotResponse,
  OrphanDeleteResponse,
} from '@k8s-hosting/api-contracts';

interface Envelope<T> { readonly data: T }

/**
 * List orphaned PVs / Longhorn volumes cluster-wide. Used by the
 * "Manage Orphaned Volumes" modal on the Storage tab. Re-fetched on
 * mount; the inventory tile gets its count from the platform-storage
 * endpoint instead, so this hook is only loaded when the modal opens.
 */
export function useOrphanedVolumes(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['orphaned-volumes'],
    queryFn: () =>
      apiFetch<Envelope<OrphanedVolumesReport>>('/api/v1/admin/orphaned-volumes'),
    enabled: opts.enabled ?? true,
    // Listing iterates every PV + Longhorn volume cluster-wide, so it's
    // not free — keep the cache hot for 30s while the modal is open and
    // fall back to a fresh fetch only when the operator manually refreshes.
    staleTime: 30_000,
  });
}

export function useSnapshotOrphan() {
  return useMutation({
    mutationFn: (volumeName: string) =>
      apiFetch<Envelope<OrphanSnapshotResponse>>(
        `/api/v1/admin/orphaned-volumes/${encodeURIComponent(volumeName)}/snapshot`,
        { method: 'POST', body: JSON.stringify({}) },
      ),
  });
}

export function useDeleteOrphan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { volumeName: string; pvName: string | null }) => {
      const qs = input.pvName ? `?pvName=${encodeURIComponent(input.pvName)}` : '';
      return apiFetch<Envelope<OrphanDeleteResponse>>(
        `/api/v1/admin/orphaned-volumes/${encodeURIComponent(input.volumeName)}${qs}`,
        { method: 'DELETE' },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orphaned-volumes'] });
      qc.invalidateQueries({ queryKey: ['platform-storage'] });
      qc.invalidateQueries({ queryKey: ['nodes'] });
    },
  });
}

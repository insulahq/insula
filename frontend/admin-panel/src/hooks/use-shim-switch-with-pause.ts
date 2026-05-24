/**
 * Phase 5 (2026-05-24) — pre-switch confirm flow hooks.
 *
 * Two hooks:
 *   - useShimSwitchPreview   — GET /admin/backup-rclone-shim/switch-preview
 *   - useShimSwitchWithPause — POST /admin/backup-rclone-shim/switch-with-pause
 *
 * The preview hook is enabled-gated on a non-null targetId so the
 * modal can refetch when the operator picks a different target
 * mid-flow without spurious 400s.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  BackupShimClass,
  SwitchPreviewResponse,
  SwitchWithPauseRequest,
  SwitchWithPauseResponse,
} from '@k8s-hosting/api-contracts';

/**
 * Preview hook. Enabled for BOTH bound switches and unbinds (operator
 * unbinds also need to see what schedules + WAL get paused).
 *
 * staleTime is 0 + refetchOnMount: 'always' because this preview drives
 * a destructive Confirm — a stale cached preview could miss a target
 * disable that happened in another tab between modal-opens. The
 * preview is cheap (a few SELECTs) so re-fetching on every open is
 * the right tradeoff.
 */
export function useShimSwitchPreview(
  className: BackupShimClass,
  newTargetId: string | null,
) {
  return useQuery({
    queryKey: ['shim-switch-preview', className, newTargetId],
    queryFn: () => {
      const q = newTargetId === null ? '' : `?targetId=${encodeURIComponent(newTargetId)}`;
      return apiFetch<SwitchPreviewResponse>(
        `/api/v1/admin/backup-rclone-shim/switch-preview/${encodeURIComponent(className)}${q}`,
      );
    },
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

export function useShimSwitchWithPause(className: BackupShimClass) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SwitchWithPauseRequest) =>
      apiFetch<SwitchWithPauseResponse>(
        `/api/v1/admin/backup-rclone-shim/switch-with-pause/${encodeURIComponent(className)}`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      // Invalidate everything the modal + Routing tab + sibling
      // sections rely on. The task-center chip drives its own
      // refetch separately.
      void qc.invalidateQueries({ queryKey: ['shim-assignments'] });
      void qc.invalidateQueries({ queryKey: ['backup-schedules'] });
      void qc.invalidateQueries({ queryKey: ['wal-archive-clusters'] });
      void qc.invalidateQueries({ queryKey: ['cnpg-backup-health'] });
    },
  });
}

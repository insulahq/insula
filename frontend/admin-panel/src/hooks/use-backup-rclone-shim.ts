// R-X10: TanStack Query hooks for the backup-rclone-shim admin
// surface (R-X5 endpoints).

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  BackupShimClass,
  DrainNowRequest,
  DrainNowResponse,
  ListShimAssignmentsResponse,
  PutShimAssignmentRequest,
  PutShimAssignmentResponse,
  ShimStatusResponse,
} from '@insula/api-contracts';

const ASSIGN_KEY = ['backup-rclone-shim', 'assignments'];
const STATUS_KEY = ['backup-rclone-shim', 'status'];

export function useShimAssignments() {
  return useQuery<ListShimAssignmentsResponse>({
    queryKey: ASSIGN_KEY,
    queryFn: () => apiFetch('/api/v1/admin/backup-rclone-shim/assignments'),
    staleTime: 30_000,
  });
}

export function useShimStatus() {
  return useQuery<ShimStatusResponse>({
    queryKey: STATUS_KEY,
    queryFn: () => apiFetch('/api/v1/admin/backup-rclone-shim/status'),
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
}

export function usePutShimAssignment() {
  const qc = useQueryClient();
  return useMutation<
    PutShimAssignmentResponse,
    Error,
    { className: BackupShimClass; input: PutShimAssignmentRequest }
  >({
    mutationFn: ({ className, input }) =>
      apiFetch(`/api/v1/admin/backup-rclone-shim/assignments/${className}`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    onSuccess: (response, vars) => {
      // The PUT now returns the OPTIMISTIC assignment row + a taskId;
      // the real DB write happens in the background. Splice the
      // optimistic row into the cached list so the class cards show
      // the new target name immediately. The 30s staleTime refetch
      // (or task-center completion) will replace it with the real
      // row a few seconds later. If the background pipeline fails,
      // the assignments refetch will revert the change.
      const optimistic = response.data;
      qc.setQueryData<ListShimAssignmentsResponse>(ASSIGN_KEY, (prev) => {
        if (!prev) return prev;
        const rows = prev.data.assignments ?? [];
        const idx = rows.findIndex((r) => r.className === vars.className);
        const next = idx >= 0
          ? [...rows.slice(0, idx), optimistic, ...rows.slice(idx + 1)]
          : [...rows, optimistic];
        return { ...prev, data: { ...prev.data, assignments: next } };
      });
      qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });
}

export function useShimDrainNow() {
  const qc = useQueryClient();
  return useMutation<DrainNowResponse, Error, DrainNowRequest>({
    mutationFn: (input) =>
      apiFetch('/api/v1/admin/backup-rclone-shim/drain-now', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });
}

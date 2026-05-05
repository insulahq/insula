/**
 * React Query hooks for the per-client backup schedule (Tier-1
 * scheduled tenant bundles).
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  ClientBackupSchedule,
  UpdateClientBackupScheduleInput,
} from '@k8s-hosting/api-contracts';

interface ScheduleResponse { readonly data: ClientBackupSchedule | null }

export function useClientBackupSchedule(clientId: string | null) {
  return useQuery({
    queryKey: ['backup-schedule', clientId],
    enabled: !!clientId,
    queryFn: () => apiFetch<ScheduleResponse>(`/api/v1/admin/clients/${clientId}/backup-schedule`),
  });
}

export function useUpdateClientBackupSchedule(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateClientBackupScheduleInput) =>
      apiFetch<ScheduleResponse>(`/api/v1/admin/clients/${clientId}/backup-schedule`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backup-schedule', clientId] }),
  });
}

/**
 * Force the next Tier-1 scheduler tick to fire this client's
 * scheduled bundle immediately (within 5 min). Server resets
 * last_run_at to NULL on the row.
 */
export function useRunBackupScheduleNow(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: { clientId: string; message: string } }>(
        `/api/v1/admin/clients/${clientId}/backup-schedule/run-now`,
        { method: 'POST', body: '{}' },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backup-schedule', clientId] }),
  });
}

export function useDeleteClientBackupSchedule(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: null }>(`/api/v1/admin/clients/${clientId}/backup-schedule`, {
        method: 'DELETE',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backup-schedule', clientId] }),
  });
}

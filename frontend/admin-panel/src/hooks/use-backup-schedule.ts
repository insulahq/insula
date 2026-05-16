/**
 * React Query hooks for the per-tenant backup schedule (Tier-1
 * scheduled tenant bundles).
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  TenantBackupSchedule,
  UpdateTenantBackupScheduleInput,
  ListBackupSchedulesResponse,
} from '@k8s-hosting/api-contracts';

interface ScheduleResponse { readonly data: TenantBackupSchedule | null }

/**
 * Global list of every tenant's backup schedule, joined with the
 * tenant's display name. Powers the Tenant Backup admin page's
 * "Schedules" tab.
 *
 * The API wraps the contract payload in the standard `success()`
 * envelope, so the over-the-wire shape is
 *   { data: { data: BackupScheduleSummary[] } }
 * which is why the inner-payload type (ListBackupSchedulesResponse)
 * is wrapped one more level here.
 */
interface AllSchedulesEnvelope { readonly data: ListBackupSchedulesResponse }

export function useAllBackupSchedules() {
  return useQuery({
    queryKey: ['backup-schedules', 'all'],
    queryFn: () => apiFetch<AllSchedulesEnvelope>('/api/v1/admin/backup-schedules'),
  });
}

export function useTenantBackupSchedule(tenantId: string | null) {
  return useQuery({
    queryKey: ['backup-schedule', tenantId],
    enabled: !!tenantId,
    queryFn: () => apiFetch<ScheduleResponse>(`/api/v1/admin/tenants/${tenantId}/backup-schedule`),
  });
}

export function useUpdateTenantBackupSchedule(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTenantBackupScheduleInput) =>
      apiFetch<ScheduleResponse>(`/api/v1/admin/tenants/${tenantId}/backup-schedule`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backup-schedule', tenantId] }),
  });
}

/**
 * Force the next Tier-1 scheduler tick to fire this tenant's
 * scheduled bundle immediately (within 5 min). Server resets
 * last_run_at to NULL on the row.
 *
 * Invalidates BOTH the per-tenant query AND the global list query
 * so the Tenant Backup admin page reflects the cleared lastRunAt
 * without waiting for the next refetch interval.
 */
export function useRunBackupScheduleNow(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: { tenantId: string; message: string } }>(
        `/api/v1/admin/tenants/${tenantId}/backup-schedule/run-now`,
        { method: 'POST', body: JSON.stringify({}) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backup-schedule', tenantId] });
      qc.invalidateQueries({ queryKey: ['backup-schedules', 'all'] });
    },
  });
}

export function useDeleteTenantBackupSchedule(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: null }>(`/api/v1/admin/tenants/${tenantId}/backup-schedule`, {
        method: 'DELETE',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backup-schedule', tenantId] }),
  });
}

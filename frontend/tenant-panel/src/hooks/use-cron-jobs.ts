import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateCronJobRequest, UpdateCronJobRequest } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';
import type { CronJob, PaginatedResponse } from '@/types/api';

export function useCronJobs(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['cron-jobs', tenantId],
    queryFn: () => apiFetch<PaginatedResponse<CronJob>>(`/api/v1/tenants/${tenantId}/cron-jobs`),
    enabled: Boolean(tenantId),
  });
}

/** Wire shape from @insula/api-contracts. */
type CreateCronJobInput = CreateCronJobRequest;

export function useCreateCronJob(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCronJobInput) =>
      apiFetch<{ data: CronJob }>(`/api/v1/tenants/${tenantId}/cron-jobs`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cron-jobs', tenantId] });
    },
  });
}

/**
 * Full PATCH, not just the enable toggle.
 *
 * This was typed `{ enabled?: boolean }` — narrower than the endpoint it calls,
 * which has always accepted name, schedule, target, timeout and timezone. A
 * hand-written type that under-describes the contract does not fail anywhere;
 * it just makes the rest of the endpoint unreachable from the panel, which is
 * why saved jobs could only be turned on and off and never corrected.
 */
export function useUpdateCronJob(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ cronJobId, ...input }: UpdateCronJobRequest & { cronJobId: string }) =>
      apiFetch<{ data: CronJob }>(`/api/v1/tenants/${tenantId}/cron-jobs/${cronJobId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cron-jobs', tenantId] });
    },
  });
}

export function useRunCronJob(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (cronJobId: string) =>
      apiFetch<{ data: CronJob }>(`/api/v1/tenants/${tenantId}/cron-jobs/${cronJobId}/run`, {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cron-jobs', tenantId] });
    },
  });
}

export function useDeleteCronJob(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (cronJobId: string) =>
      apiFetch<void>(`/api/v1/tenants/${tenantId}/cron-jobs/${cronJobId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cron-jobs', tenantId] });
    },
  });
}

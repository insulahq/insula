import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreatePlanRequest } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';

// CreatePlanRequest comes from @insula/api-contracts (createPlanSchema) — the shape the backend parses with.

export function useCreatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePlanRequest) =>
      apiFetch<{ data: unknown }>('/api/v1/admin/plans', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['plans'] }); },
  });
}

export function useUpdatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<CreatePlanRequest> & { id: string; status?: string }) =>
      apiFetch<{ data: unknown }>(`/api/v1/admin/plans/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['plans'] }); },
  });
}

export function useDeletePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/admin/plans/${id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['plans'] }); },
  });
}

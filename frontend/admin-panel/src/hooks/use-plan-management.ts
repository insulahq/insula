import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { CreatePlanRequest } from '@insula/api-contracts';
// NOTE: `Plan` is declared in use-plans.ts rather than in @insula/api-contracts,
// which is where response types are supposed to live. Left as-is here — moving
// it is a separate change — but it is the kind of local API type that drifts
// from the backend without anything failing to compile.
import type { Plan } from './use-plans';
import { apiFetch } from '@/lib/api-client';

// CreatePlanRequest comes from @insula/api-contracts (createPlanSchema) — the shape the backend parses with.

interface PlanListEnvelope {
  readonly data: readonly Plan[];
}

/**
 * Put the plan the server just returned into the cached list.
 *
 * `invalidateQueries` alone is not enough here, and the reason is worth
 * recording. `GET /api/v1/plans` is unauthenticated, so it sits behind a
 * server-side response cache — a per-PROCESS map. The api runs more than one
 * replica in HA, so the refetch that invalidation triggers can land on a
 * replica that did not serve the write and still holds the old list. The panel
 * then caches THAT answer and shows the pre-edit numbers, which is
 * indistinguishable from the save having failed.
 *
 * The mutation response is the authoritative post-write row, so it is written
 * straight into the list. Invalidation still runs behind it to pick up
 * anything else that changed.
 */
function seedPlanIntoList(qc: QueryClient, updated: Plan | undefined): void {
  if (!updated?.id) return;
  qc.setQueryData<PlanListEnvelope>(['plans'], (prev) => {
    if (!prev?.data) return prev;
    let found = false;
    const data = prev.data.map((p) => {
      if (p.id !== updated.id) return p;
      found = true;
      return updated;
    });
    // A newly created plan is not in the list yet.
    return { ...prev, data: found ? data : [...prev.data, updated] };
  });
}

export function useCreatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePlanRequest) =>
      apiFetch<{ data: Plan }>('/api/v1/admin/plans', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: (res) => {
      seedPlanIntoList(qc, res?.data);
      qc.invalidateQueries({ queryKey: ['plans'] });
    },
  });
}

export function useUpdatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<CreatePlanRequest> & { id: string; status?: string }) =>
      apiFetch<{ data: Plan }>(`/api/v1/admin/plans/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    onSuccess: (res) => {
      seedPlanIntoList(qc, res?.data);
      qc.invalidateQueries({ queryKey: ['plans'] });
    },
  });
}

export function useDeletePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/admin/plans/${id}`, { method: 'DELETE' }),
    // Delete is a soft-delete to `deprecated` and returns no body, so there is
    // nothing to seed — the refetch carries the new status.
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['plans'] }); },
  });
}

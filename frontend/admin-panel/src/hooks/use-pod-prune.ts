import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { PodPrunePolicy, PodPruneResult } from '@insula/api-contracts';

interface PolicyEnvelope { readonly data: PodPrunePolicy }
interface ResultEnvelope { readonly data: PodPruneResult }

export function usePodPrunePolicy() {
  return useQuery({
    queryKey: ['admin', 'pods', 'prune-policy'],
    queryFn: () => apiFetch<PolicyEnvelope>('/api/v1/admin/pods/prune-policy'),
    staleTime: 60_000,
  });
}

export function useSetPodPrunePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (autoPruneDays: number) =>
      apiFetch<PolicyEnvelope>('/api/v1/admin/pods/prune-policy', {
        method: 'PUT',
        body: JSON.stringify({ autoPruneDays }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'pods', 'prune-policy'] });
    },
  });
}

/**
 * Sweep dead pod records now.
 *
 * Sends no `olderThanDays`, so the server uses 0 — every dead record. An
 * operator pressing "Prune Dead Pods" means now, not eventually.
 */
export function usePrunePods() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<ResultEnvelope>('/api/v1/admin/pods/prune', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      // The pod list carries the records we just deleted, so it is stale the
      // moment this returns.
      void qc.invalidateQueries({ queryKey: ['admin', 'pods'] });
    },
  });
}

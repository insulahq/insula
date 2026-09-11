import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { FailbackReview, FailbackReviewItem, FailbackRecommendation } from '@insula/api-contracts';

export type { FailbackReview, FailbackReviewItem, FailbackRecommendation };

interface FailbackReviewEnvelope {
  readonly data: FailbackReview;
}

/**
 * Tenants still displaced from a node that has come back.
 *
 * Polled far more slowly than the outage impact, because nothing here is
 * urgent — the cluster is healthy again by definition and these are decisions,
 * not incidents. The point is that the placement changes made during an outage
 * do not quietly become permanent without the operator ever seeing them.
 */
export function useFailbackReview() {
  return useQuery({
    queryKey: ['cluster', 'failback-review'],
    queryFn: () => apiFetch<FailbackReviewEnvelope>('/api/v1/admin/cluster/failback-review'),
    refetchInterval: 120_000,
  });
}

/** Accept a tenant's current placement, closing its review. Moves no data. */
export function useAcknowledgeFailback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tenantId, reason }: { tenantId: string; reason: string }) =>
      apiFetch(`/api/v1/admin/tenants/${tenantId}/failback/acknowledge`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cluster', 'failback-review'] });
    },
  });
}

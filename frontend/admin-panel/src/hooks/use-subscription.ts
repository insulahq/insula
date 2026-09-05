import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UpdateSubscriptionRequest } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';
import type { SubscriptionResponse } from '@/types/api';

export function useSubscription(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['subscription', tenantId],
    queryFn: () => apiFetch<{ data: SubscriptionResponse }>(`/api/v1/tenants/${tenantId}/subscription`),
    enabled: Boolean(tenantId),
  });
}

// UpdateSubscriptionRequest comes from @insula/api-contracts (updateSubscriptionSchema) — the shape the backend parses with.

export function useUpdateSubscription(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSubscriptionRequest) =>
      apiFetch<{ data: SubscriptionResponse }>(`/api/v1/tenants/${tenantId}/subscription`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['subscription', tenantId] });
      queryClient.invalidateQueries({ queryKey: ['tenant', tenantId] });
    },
  });
}

export function useCheckExpiry() {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: { suspended_count: number } }>('/api/v1/admin/check-expiry', {
        method: 'POST',
      }),
  });
}

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { SubscriptionResponse } from '@/types/api';

export function useSubscription(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['subscription', tenantId],
    queryFn: () => apiFetch<{ data: SubscriptionResponse }>(`/api/v1/tenants/${tenantId}/subscription`),
    enabled: Boolean(tenantId),
  });
}

interface UpdateSubscriptionInput {
  readonly plan_id?: string;
  readonly subscription_expires_at?: string;
  readonly status?: string;
  readonly notes?: string;
}

export function useUpdateSubscription(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSubscriptionInput) =>
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

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UpdateLoadBalancerRequest } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';

export type LoadBalancerProvider = 'null' | 'hetzner' | 'aws' | 'metallb';

export interface LoadBalancerStatus {
  readonly enabled: boolean;
  readonly provider: LoadBalancerProvider;
  readonly haGate: { readonly met: boolean; readonly required: number; readonly current: number };
  readonly providerImplemented: boolean;
  readonly message: string;
}

export function useLoadBalancer() {
  return useQuery({
    queryKey: ['load-balancer'],
    queryFn: () => apiFetch<{ data: LoadBalancerStatus }>('/api/v1/admin/load-balancer'),
    refetchInterval: 30_000,
  });
}

// UpdateLoadBalancerRequest comes from @insula/api-contracts (updateLoadBalancerSchema) — the shape the backend parses with.

export function useUpdateLoadBalancer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateLoadBalancerRequest) =>
      apiFetch<{ data: LoadBalancerStatus }>('/api/v1/admin/load-balancer', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['load-balancer'] }),
  });
}

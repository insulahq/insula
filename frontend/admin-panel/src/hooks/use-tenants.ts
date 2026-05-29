import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { Tenant, PaginatedResponse } from '@/types/api';
import type { CreateTenantInput, UpdateTenantInput, CreateTenantResponse } from '@insula/api-contracts';

interface ListTenantsParams {
  readonly search?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export function useTenants(params: ListTenantsParams = {}) {
  const searchParams = new URLSearchParams();
  if (params.search) searchParams.set('search', params.search);
  if (params.limit) searchParams.set('limit', String(params.limit));
  if (params.cursor) searchParams.set('cursor', params.cursor);

  const qs = searchParams.toString();
  const path = `/api/v1/tenants${qs ? `?${qs}` : ''}`;

  return useQuery({
    queryKey: ['tenants', params],
    queryFn: () => apiFetch<PaginatedResponse<Tenant>>(path),
  });
}

export function useTenant(id: string | undefined) {
  return useQuery({
    queryKey: ['tenants', id],
    queryFn: () => apiFetch<{ data: Tenant }>(`/api/v1/tenants/${id}`),
    enabled: !!id,
    // Poll every 3s while provisioning is in progress (stops once provisioned/failed)
    refetchInterval: (query) => {
      const status = (query.state.data?.data as Record<string, unknown> | undefined)?.provisioningStatus;
      return (status === 'provisioning' || status === 'unprovisioned') ? 3000 : false;
    },
  });
}

export function useCreateTenant() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateTenantInput) =>
      apiFetch<{ data: CreateTenantResponse }>('/api/v1/tenants', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tenants'] });
    },
  });
}

export function useUpdateTenant(id: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateTenantInput) =>
      apiFetch<{ data: Tenant }>(`/api/v1/tenants/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tenants'] });
      queryClient.invalidateQueries({ queryKey: ['tenants', id] });
    },
  });
}

export function useDeleteTenant() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: { transitionId: string | null } }>(`/api/v1/tenants/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tenants'] });
    },
  });
}

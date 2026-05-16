import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  ZitiProviderInput,
  ZitiProviderResponse,
  ZitiProviderTestResponse,
} from '@k8s-hosting/api-contracts';

interface ApiEnvelope<T> {
  readonly data: T;
}

const KEY = (cid: string) => ['ziti-providers', cid] as const;

export function useZitiProviders(tenantId: string | undefined) {
  return useQuery({
    queryKey: KEY(tenantId ?? ''),
    queryFn: async () => {
      const res = await apiFetch<ApiEnvelope<ZitiProviderResponse[]>>(
        `/api/v1/tenants/${tenantId}/ziti-providers`,
      );
      return res.data;
    },
    enabled: Boolean(tenantId),
  });
}

export function useCreateZitiProvider(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ZitiProviderInput) => {
      const res = await apiFetch<ApiEnvelope<ZitiProviderResponse>>(
        `/api/v1/tenants/${tenantId}/ziti-providers`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(tenantId) }),
  });
}

export function useUpdateZitiProvider(tenantId: string, providerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<ZitiProviderInput>) => {
      const res = await apiFetch<ApiEnvelope<ZitiProviderResponse>>(
        `/api/v1/tenants/${tenantId}/ziti-providers/${providerId}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(tenantId) }),
  });
}

export function useDeleteZitiProvider(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (providerId: string) => {
      await apiFetch<ApiEnvelope<{ deleted: boolean }>>(
        `/api/v1/tenants/${tenantId}/ziti-providers/${providerId}`,
        { method: 'DELETE' },
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(tenantId) }),
  });
}

export function useTestZitiProvider(tenantId: string, providerId: string) {
  return useMutation({
    mutationFn: async (controllerUrl: string) => {
      const res = await apiFetch<ApiEnvelope<ZitiProviderTestResponse>>(
        `/api/v1/tenants/${tenantId}/ziti-providers/${providerId}/test`,
        { method: 'POST', body: JSON.stringify({ controllerUrl }) },
      );
      return res.data;
    },
  });
}

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  ZrokProviderInput,
  ZrokProviderResponse,
  ZrokProviderTestResponse,
} from '@k8s-hosting/api-contracts';

interface ApiEnvelope<T> {
  readonly data: T;
}

const KEY = (cid: string) => ['zrok-providers', cid] as const;

export function useZrokProviders(tenantId: string | undefined) {
  return useQuery({
    queryKey: KEY(tenantId ?? ''),
    queryFn: async () => {
      const res = await apiFetch<ApiEnvelope<ZrokProviderResponse[]>>(
        `/api/v1/tenants/${tenantId}/zrok-providers`,
      );
      return res.data;
    },
    enabled: Boolean(tenantId),
  });
}

export function useCreateZrokProvider(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ZrokProviderInput) => {
      const res = await apiFetch<ApiEnvelope<ZrokProviderResponse>>(
        `/api/v1/tenants/${tenantId}/zrok-providers`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(tenantId) }),
  });
}

export function useUpdateZrokProvider(tenantId: string, providerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<ZrokProviderInput>) => {
      const res = await apiFetch<ApiEnvelope<ZrokProviderResponse>>(
        `/api/v1/tenants/${tenantId}/zrok-providers/${providerId}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(tenantId) }),
  });
}

export function useDeleteZrokProvider(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (providerId: string) => {
      await apiFetch<ApiEnvelope<{ deleted: boolean }>>(
        `/api/v1/tenants/${tenantId}/zrok-providers/${providerId}`,
        { method: 'DELETE' },
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(tenantId) }),
  });
}

export function useTestZrokProvider(tenantId: string, providerId: string) {
  return useMutation({
    mutationFn: async (controllerUrl: string) => {
      const res = await apiFetch<ApiEnvelope<ZrokProviderTestResponse>>(
        `/api/v1/tenants/${tenantId}/zrok-providers/${providerId}/test`,
        { method: 'POST', body: JSON.stringify({ controllerUrl }) },
      );
      return res.data;
    },
  });
}

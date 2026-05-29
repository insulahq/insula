import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  IngressMtlsConfigInput,
  IngressMtlsConfigResponse,
} from '@insula/api-contracts';

interface ApiEnvelope<T> {
  readonly data: T;
}

const KEY = (cid: string, rid: string) => ['ingress-mtls', cid, rid] as const;

export function useIngressMtls(tenantId: string | undefined, routeId: string | undefined) {
  return useQuery({
    queryKey: KEY(tenantId ?? '', routeId ?? ''),
    queryFn: async () => {
      const res = await apiFetch<ApiEnvelope<IngressMtlsConfigResponse | null>>(
        `/api/v1/tenants/${tenantId}/ingress-routes/${routeId}/mtls`,
      );
      return res.data;
    },
    enabled: Boolean(tenantId && routeId),
  });
}

export function useUpsertIngressMtls(tenantId: string, routeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: IngressMtlsConfigInput) => {
      const res = await apiFetch<ApiEnvelope<IngressMtlsConfigResponse>>(
        `/api/v1/tenants/${tenantId}/ingress-routes/${routeId}/mtls`,
        { method: 'PATCH', body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(tenantId, routeId) }),
  });
}

export function useDeleteIngressMtls(tenantId: string, routeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await apiFetch<ApiEnvelope<{ deleted: boolean }>>(
        `/api/v1/tenants/${tenantId}/ingress-routes/${routeId}/mtls`,
        { method: 'DELETE' },
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(tenantId, routeId) }),
  });
}

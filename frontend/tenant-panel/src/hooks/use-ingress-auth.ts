import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  IngressAuthConfigInput,
  IngressAuthConfigResponse,
  IngressAuthTestResponse,
  OidcProviderInput,
  OidcProviderResponse,
} from '@k8s-hosting/api-contracts';

interface ApiEnvelope<T> {
  readonly data: T;
}

const PROVIDERS_KEY = (cid: string) => ['oidc-providers', cid] as const;

/** List per-client OIDC providers — feeds the dropdown in OidcSection. */
export function useOidcProviders(tenantId: string | undefined) {
  return useQuery({
    queryKey: PROVIDERS_KEY(tenantId ?? ''),
    queryFn: async () => {
      const res = await apiFetch<ApiEnvelope<OidcProviderResponse[]>>(
        `/api/v1/tenants/${tenantId}/oidc-providers`,
      );
      return res.data;
    },
    enabled: Boolean(tenantId),
  });
}

export function useCreateOidcProvider(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: OidcProviderInput) => {
      const res = await apiFetch<ApiEnvelope<OidcProviderResponse>>(
        `/api/v1/tenants/${tenantId}/oidc-providers`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PROVIDERS_KEY(tenantId) }),
  });
}

export function useUpdateOidcProvider(tenantId: string, providerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<OidcProviderInput>) => {
      const res = await apiFetch<ApiEnvelope<OidcProviderResponse>>(
        `/api/v1/tenants/${tenantId}/oidc-providers/${providerId}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PROVIDERS_KEY(tenantId) }),
  });
}

export function useDeleteOidcProvider(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (providerId: string) => {
      await apiFetch<ApiEnvelope<{ deleted: boolean }>>(
        `/api/v1/tenants/${tenantId}/oidc-providers/${providerId}`,
        { method: 'DELETE' },
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PROVIDERS_KEY(tenantId) }),
  });
}

const KEY = (cid: string, rid: string) => ['ingress-auth', cid, rid] as const;

export function useIngressAuth(tenantId: string | undefined, routeId: string | undefined) {
  return useQuery({
    queryKey: KEY(tenantId ?? '', routeId ?? ''),
    queryFn: async () => {
      const res = await apiFetch<ApiEnvelope<IngressAuthConfigResponse | null>>(
        `/api/v1/tenants/${tenantId}/ingress-routes/${routeId}/auth`,
      );
      return res.data;
    },
    enabled: Boolean(tenantId && routeId),
  });
}

export function useUpsertIngressAuth(tenantId: string, routeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: IngressAuthConfigInput) => {
      const res = await apiFetch<ApiEnvelope<IngressAuthConfigResponse>>(
        `/api/v1/tenants/${tenantId}/ingress-routes/${routeId}/auth`,
        { method: 'PATCH', body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(tenantId, routeId) }),
  });
}

export function useDeleteIngressAuth(tenantId: string, routeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await apiFetch<ApiEnvelope<{ deleted: boolean }>>(
        `/api/v1/tenants/${tenantId}/ingress-routes/${routeId}/auth`,
        { method: 'DELETE' },
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(tenantId, routeId) }),
  });
}

export function useTestIngressAuth(tenantId: string, routeId: string) {
  return useMutation({
    mutationFn: async (issuerUrl: string) => {
      const res = await apiFetch<ApiEnvelope<IngressAuthTestResponse>>(
        `/api/v1/tenants/${tenantId}/ingress-routes/${routeId}/auth/test`,
        { method: 'POST', body: JSON.stringify({ issuerUrl }) },
      );
      return res.data;
    },
  });
}

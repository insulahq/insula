import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  MtlsProviderInput,
  MtlsProviderUpdate,
  MtlsProviderResponse,
  MtlsIssueCertInput,
  MtlsIssueCertResponse,
  CertificateResponse,
  CertificateStatus,
  ListCertificatesResponse,
  RevokeCertificateInput,
  CrlMetadataResponse,
} from '@insula/api-contracts';

interface ApiEnvelope<T> {
  readonly data: T;
}

const KEY = (cid: string) => ['mtls-providers', cid] as const;
const CERTS_KEY = (cid: string, pid: string, status?: CertificateStatus | 'all') =>
  ['mtls-providers', cid, pid, 'certificates', status ?? 'all'] as const;
const CRL_KEY = (cid: string, pid: string) =>
  ['mtls-providers', cid, pid, 'crl'] as const;

export function useMtlsProviders(tenantId: string | undefined) {
  return useQuery({
    queryKey: KEY(tenantId ?? ''),
    queryFn: async () => {
      const res = await apiFetch<ApiEnvelope<MtlsProviderResponse[]>>(
        `/api/v1/tenants/${tenantId}/mtls-providers`,
      );
      return res.data;
    },
    enabled: Boolean(tenantId),
  });
}

export function useCreateMtlsProvider(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: MtlsProviderInput) => {
      const res = await apiFetch<ApiEnvelope<MtlsProviderResponse>>(
        `/api/v1/tenants/${tenantId}/mtls-providers`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(tenantId) }),
  });
}

export function useUpdateMtlsProvider(tenantId: string, providerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: MtlsProviderUpdate) => {
      const res = await apiFetch<ApiEnvelope<MtlsProviderResponse>>(
        `/api/v1/tenants/${tenantId}/mtls-providers/${providerId}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(tenantId) }),
  });
}

export function useDeleteMtlsProvider(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (providerId: string) => {
      await apiFetch<ApiEnvelope<{ deleted: boolean }>>(
        `/api/v1/tenants/${tenantId}/mtls-providers/${providerId}`,
        { method: 'DELETE' },
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(tenantId) }),
  });
}

export function useIssueMtlsCert(tenantId: string, providerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: MtlsIssueCertInput) => {
      const res = await apiFetch<ApiEnvelope<MtlsIssueCertResponse>>(
        `/api/v1/tenants/${tenantId}/mtls-providers/${providerId}/issue-cert`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => {
      // New cert exists — refresh both the list and the CRL metadata.
      qc.invalidateQueries({ queryKey: ['mtls-providers', tenantId, providerId, 'certificates'] });
      qc.invalidateQueries({ queryKey: CRL_KEY(tenantId, providerId) });
    },
  });
}

export function useMtlsCertificates(
  tenantId: string | undefined,
  providerId: string | undefined,
  status: CertificateStatus | 'all' = 'all',
) {
  return useQuery({
    queryKey: CERTS_KEY(tenantId ?? '', providerId ?? '', status),
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (status !== 'all') qs.set('status', status);
      qs.set('limit', '100');
      const res = await apiFetch<ApiEnvelope<ListCertificatesResponse>>(
        `/api/v1/tenants/${tenantId}/mtls-providers/${providerId}/certificates?${qs.toString()}`,
      );
      return res.data;
    },
    enabled: Boolean(tenantId) && Boolean(providerId),
  });
}

export function useRevokeMtlsCertificate(tenantId: string, providerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { certId: string; input: RevokeCertificateInput }) => {
      const res = await apiFetch<ApiEnvelope<CertificateResponse>>(
        `/api/v1/tenants/${tenantId}/mtls-providers/${providerId}/certificates/${vars.certId}/revoke`,
        { method: 'POST', body: JSON.stringify(vars.input) },
      );
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mtls-providers', tenantId, providerId, 'certificates'] });
      qc.invalidateQueries({ queryKey: CRL_KEY(tenantId, providerId) });
    },
  });
}

export function useUnrevokeMtlsCertificate(tenantId: string, providerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (certId: string) => {
      const res = await apiFetch<ApiEnvelope<CertificateResponse>>(
        `/api/v1/tenants/${tenantId}/mtls-providers/${providerId}/certificates/${certId}/unrevoke`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mtls-providers', tenantId, providerId, 'certificates'] });
      qc.invalidateQueries({ queryKey: CRL_KEY(tenantId, providerId) });
    },
  });
}

export function useDeleteMtlsCertificate(tenantId: string, providerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (certId: string) => {
      await apiFetch<unknown>(
        `/api/v1/tenants/${tenantId}/mtls-providers/${providerId}/certificates/${certId}`,
        { method: 'DELETE' },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mtls-providers', tenantId, providerId, 'certificates'] });
      qc.invalidateQueries({ queryKey: CRL_KEY(tenantId, providerId) });
    },
  });
}

export function useMtlsCrlMetadata(tenantId: string | undefined, providerId: string | undefined) {
  return useQuery({
    queryKey: CRL_KEY(tenantId ?? '', providerId ?? ''),
    queryFn: async () => {
      const res = await apiFetch<ApiEnvelope<CrlMetadataResponse>>(
        `/api/v1/tenants/${tenantId}/mtls-providers/${providerId}/crl`,
      );
      return res.data;
    },
    enabled: Boolean(tenantId) && Boolean(providerId),
  });
}

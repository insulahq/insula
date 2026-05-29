import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { SslCertResponse, UploadSslCertInput } from '@insula/api-contracts';

function basePath(tenantId: string, domainId: string) {
  return `/api/v1/tenants/${tenantId}/domains/${domainId}/ssl-cert`;
}

export function useSslCert(tenantId: string | undefined, domainId: string | undefined) {
  return useQuery({
    queryKey: ['ssl-cert', tenantId, domainId],
    queryFn: () => apiFetch<{ data: SslCertResponse }>(basePath(tenantId!, domainId!)),
    enabled: Boolean(tenantId && domainId),
    retry: false, // 404 means no cert — don't retry
  });
}

export function useUploadSslCert(tenantId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UploadSslCertInput) =>
      apiFetch<{ data: SslCertResponse }>(basePath(tenantId!, domainId!), {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ssl-cert', tenantId, domainId] });
    },
  });
}

export function useDeleteSslCert(tenantId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      apiFetch<void>(basePath(tenantId!, domainId!), { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ssl-cert', tenantId, domainId] });
    },
  });
}

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateDnsRecordRequest } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';
import type { DnsRecordResponse } from '@/types/api';

function basePath(tenantId: string, domainId: string) {
  return `/api/v1/tenants/${tenantId}/domains/${domainId}/dns-records`;
}

export function useDnsRecords(tenantId: string | undefined, domainId: string | undefined) {
  return useQuery({
    queryKey: ['dns-records', tenantId, domainId],
    queryFn: () => apiFetch<{ data: readonly DnsRecordResponse[] }>(basePath(tenantId!, domainId!)),
    enabled: Boolean(tenantId && domainId),
  });
}

/** Wire shape from @insula/api-contracts. */
type CreateDnsRecordInput = CreateDnsRecordRequest;

export function useCreateDnsRecord(tenantId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateDnsRecordInput) =>
      apiFetch<{ data: DnsRecordResponse }>(basePath(tenantId!, domainId!), {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dns-records', tenantId, domainId] });
    },
  });
}

interface UpdateDnsRecordInput {
  readonly record_value?: string;
  readonly ttl?: number;
  readonly priority?: number;
  readonly weight?: number;
  readonly port?: number;
}

export function useUpdateDnsRecord(tenantId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ recordId, ...input }: UpdateDnsRecordInput & { readonly recordId: string }) =>
      apiFetch<{ data: DnsRecordResponse }>(`${basePath(tenantId!, domainId!)}/${recordId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dns-records', tenantId, domainId] });
    },
  });
}

export function useDeleteDnsRecord(tenantId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (recordId: string) =>
      apiFetch<void>(`${basePath(tenantId!, domainId!)}/${recordId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dns-records', tenantId, domainId] });
    },
  });
}

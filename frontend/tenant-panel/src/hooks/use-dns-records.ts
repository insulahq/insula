import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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

interface CreateDnsRecordInput {
  readonly record_type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'SRV' | 'NS';
  readonly record_name?: string;
  readonly record_value: string;
  readonly ttl?: number;
  readonly priority?: number;
}

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

export function useSyncDnsRecords(tenantId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: readonly DnsRecordResponse[] }>(`${basePath(tenantId!, domainId!)}/sync`, {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dns-records', tenantId, domainId] });
    },
  });
}

export interface DnsRecordDiffEntry {
  readonly type: string;
  readonly name: string;
  readonly local: { value: string; ttl: number; id: string } | null;
  readonly remote: { value: string; ttl: number } | null;
  readonly status: 'in_sync' | 'conflict' | 'local_only' | 'remote_only';
}

export function useDnsRecordDiff(tenantId: string | undefined, domainId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['dns-record-diff', tenantId, domainId],
    queryFn: () => apiFetch<{ data: readonly DnsRecordDiffEntry[] }>(
      `${basePath(tenantId!, domainId!)}/diff`
    ),
    enabled: Boolean(tenantId && domainId) && enabled,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  });
}

export function usePullDnsRecord(tenantId: string | undefined, domainId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { type: string; name: string; value: string; ttl?: number; local_id?: string }) =>
      apiFetch(`${basePath(tenantId!, domainId!)}/pull`, {
        method: 'POST', body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dns-records'] });
      qc.invalidateQueries({ queryKey: ['dns-record-diff'] });
    },
  });
}

export function usePushDnsRecord(tenantId: string | undefined, domainId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { type: string; name: string; value: string; ttl?: number }) =>
      apiFetch(`${basePath(tenantId!, domainId!)}/push`, {
        method: 'POST', body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dns-record-diff'] });
    },
  });
}

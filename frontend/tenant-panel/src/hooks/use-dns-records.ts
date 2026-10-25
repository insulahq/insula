import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateDnsRecordInput, UpdateDnsRecordInput } from '@insula/api-contracts';
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

export interface DnsRecordDiffEntry {
  readonly type: string;
  readonly name: string;
  /** priority/weight/port travel with the entry so Push can send a
   *  complete MX/SRV record — see backend dns-records/diff.ts. */
  readonly local: {
    value: string; ttl: number; id: string;
    priority?: number | null; weight?: number | null; port?: number | null;
  } | null;
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
    mutationFn: (input: {
      type: string; name: string; value: string; ttl?: number; priority?: number; weight?: number; port?: number;
      /** The server's value this push replaces (a conflict). */
      replaces?: string;
    }) =>
      apiFetch(`${basePath(tenantId!, domainId!)}/push`, {
        method: 'POST', body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dns-record-diff'] });
    },
  });
}

/** Sync Records: drop a local row only; the DNS server is not touched. */
export function useRemoveLocalDnsRecord(tenantId: string | undefined, domainId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (localId: string) =>
      apiFetch(`${basePath(tenantId!, domainId!)}/remove-local`, {
        method: 'POST', body: JSON.stringify({ local_id: localId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dns-records'] });
      qc.invalidateQueries({ queryKey: ['dns-record-diff'] });
    },
  });
}

/** Sync Records: withdraw one value from the DNS server only. */
export function useRemoveRemoteDnsRecord(tenantId: string | undefined, domainId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { type: string; name: string; value: string }) =>
      apiFetch(`${basePath(tenantId!, domainId!)}/remove-remote`, {
        method: 'POST', body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dns-record-diff'] });
    },
  });
}

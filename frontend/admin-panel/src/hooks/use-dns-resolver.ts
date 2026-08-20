import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { DnsResolverStatus, DnsResolverSettings } from '@insula/api-contracts';

const KEY = ['platform', 'dns-resolver'] as const;

export function useDnsResolver() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => apiFetch<{ data: DnsResolverStatus }>('/api/v1/admin/platform/dns-resolver'),
    select: (r) => r.data,
  });
}

export function useUpdateDnsResolver() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DnsResolverSettings) =>
      apiFetch<{ data: DnsResolverSettings }>('/api/v1/admin/platform/dns-resolver', {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

/**
 * Test candidate upstreams WITHOUT saving them, so an operator cannot lock the
 * platform onto a blackholed resolver and only find out when domain
 * verification starts failing.
 */
export function useProbeDnsResolver() {
  return useMutation({
    mutationFn: (servers: readonly string[]) =>
      apiFetch<{ data: { ok: boolean; detail: string } }>(
        '/api/v1/admin/platform/dns-resolver/probe',
        { method: 'POST', body: JSON.stringify({ servers }) },
      ),
    });
}

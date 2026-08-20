import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { Domain, PaginatedResponse } from '@/types/api';

interface ListDomainsParams {
  readonly search?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * Certificate issuance and DNS provisioning finish SERVER-SIDE, after the
 * mutation that started them has already returned. Invalidating on mutation
 * success therefore refetches too early and the panel keeps showing the
 * pre-work state until the user reloads — "requested a certificate, still says
 * pending".
 *
 * Invalidation cannot fix that on its own; the query has to keep looking while
 * the work is in flight. Poll only while something is actually transitional
 * and stop as soon as nothing is, so an idle domains page costs nothing.
 */
const TRANSITIONAL_CERT_STATUSES = new Set(['pending', 'issuing', 'unknown']);

function domainsNeedPolling(items: ReadonlyArray<{ tlsCertStatus?: string; status?: string }> | undefined): boolean {
  if (!items) return false;
  return items.some(
    (d) =>
      (d.tlsCertStatus !== undefined && TRANSITIONAL_CERT_STATUSES.has(d.tlsCertStatus))
      || d.status === 'pending',
  );
}

export function useDomains(tenantId: string | undefined, params: ListDomainsParams = {}) {
  const searchParams = new URLSearchParams();
  if (params.search) searchParams.set('search', params.search);
  if (params.limit) searchParams.set('limit', String(params.limit));
  if (params.cursor) searchParams.set('cursor', params.cursor);

  const qs = searchParams.toString();
  const path = tenantId
    ? `/api/v1/tenants/${tenantId}/domains${qs ? `?${qs}` : ''}`
    : `/api/v1/admin/domains${qs ? `?${qs}` : ''}`;

  return useQuery({
    queryKey: ['domains', tenantId ?? 'all', params],
    queryFn: () => apiFetch<PaginatedResponse<Domain>>(path),
    // 5s while a certificate is issuing or a domain is still pending; off
    // otherwise, so an idle list costs nothing.
    refetchInterval: (query) =>
      domainsNeedPolling(
        (query.state.data as { data?: ReadonlyArray<{ tlsCertStatus?: string; status?: string }> } | undefined)?.data,
      )
        ? 5000
        : false,
  });
}

interface CreateDomainInput {
  readonly domain_name: string;
  readonly dns_mode: 'cname' | 'primary' | 'secondary';
  readonly deployment_id?: string;
}

export function useCreateDomain(tenantId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateDomainInput) =>
      apiFetch<{ data: Domain }>(`/api/v1/tenants/${tenantId}/domains`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domains', tenantId] });
    },
  });
}

interface UpdateDomainInput {
  readonly dns_mode?: 'cname' | 'primary' | 'secondary';
  readonly ssl_auto_renew?: boolean;
  readonly deployment_id?: string | null;
  readonly status?: 'active' | 'pending' | 'suspended' | 'deleted';
}

export function useUpdateDomain(tenantId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ domainId, ...input }: UpdateDomainInput & { domainId: string }) =>
      apiFetch<{ data: Domain }>(`/api/v1/tenants/${tenantId}/domains/${domainId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domains'] });
    },
  });
}

export interface VerificationCheck {
  readonly type: string;
  readonly status: 'pass' | 'fail';
  readonly detail: string;
}

export interface VerificationResult {
  readonly verified: boolean;
  readonly checks: readonly VerificationCheck[];
  readonly domainId: string;
  readonly domainName: string;
}

export function useVerifyDomain(tenantId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (domainId: string) =>
      apiFetch<{ data: VerificationResult }>(
        // force=true: results (INCLUDING failures) cache for 24h server-side.
        // Without this the button returns the stored failure, so an operator
        // who fixes their DNS sees no change for a day and reasonably
        // concludes the fix did not work.
        `/api/v1/tenants/${tenantId}/domains/${domainId}/verify?force=true`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domains', tenantId] });
    },
  });
}

export function useDeleteDomain(tenantId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (domainId: string) =>
      apiFetch<void>(`/api/v1/tenants/${tenantId}/domains/${domainId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domains', tenantId] });
    },
  });
}

/**
 * Re-derive ingress-route DNS from the CURRENT ingress address set.
 *
 * Apex A/AAAA records are a snapshot taken when the route was created, so
 * adding an ingress-capable node leaves existing apexes pointing at the old
 * set. Subdomains ride the <slug>.ingress.<apex> CNAME chain and self-heal.
 * Primary mode only — the API 409s otherwise.
 */
export function useRefreshRouteDns(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (domainId: string) =>
      apiFetch<{ data: { hostnames: number; created: number; removed: number; failures: Array<{ hostname: string; detail: string }> } }>(
        `/api/v1/tenants/${tenantId}/domains/${domainId}/refresh-route-dns`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      // The records list is the thing this action changes — invalidate it, or
      // the panel shows the pre-refresh set until a manual reload.
      queryClient.invalidateQueries({ queryKey: ['dns-records'] });
      queryClient.invalidateQueries({ queryKey: ['domains', tenantId] });
    },
  });
}

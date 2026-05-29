import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { Domain, PaginatedResponse } from '@/types/api';
import type { DomainDeletePreview } from '@insula/api-contracts';

// Re-export so existing imports from `use-domains.ts` keep working.
export type { DomainDeletePreview };

export function useDomains(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['domains', tenantId],
    queryFn: () =>
      apiFetch<PaginatedResponse<Domain>>(
        `/api/v1/tenants/${tenantId}/domains`,
      ),
    enabled: Boolean(tenantId),
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

export function useDeleteDomain(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (domainId: string) =>
      apiFetch<void>(`/api/v1/tenants/${tenantId}/domains/${domainId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domains'] });
      // Round-3: deleting a domain cascades to email_domains and
      // mailboxes via migration 0020, so refresh those caches too.
      queryClient.invalidateQueries({ queryKey: ['email-domains', tenantId] });
      queryClient.invalidateQueries({ queryKey: ['mailboxes', tenantId] });
      queryClient.invalidateQueries({ queryKey: ['mailbox-usage', tenantId] });
    },
  });
}

// Round-3: dynamic cascade preview for the delete confirmation dialog.
// `enabled` is the caller's flag — typically only true when the modal
// is open, to avoid hitting the API on every DomainDetail page load.
export function useDomainDeletePreview(
  tenantId: string | undefined,
  domainId: string | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['domain-delete-preview', tenantId, domainId],
    queryFn: () =>
      apiFetch<{ data: DomainDeletePreview }>(
        `/api/v1/tenants/${tenantId}/domains/${domainId}/delete-preview`,
      ),
    enabled: enabled && Boolean(tenantId && domainId),
    staleTime: 0,
  });
}

export function useVerifyDomain(tenantId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (domainId: string) =>
      apiFetch<{ data: VerificationResult }>(
        `/api/v1/tenants/${tenantId}/domains/${domainId}/verify`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domains', tenantId] });
    },
  });
}

// ─── Platform ingress base domain ──────────────────────────────────────────
// Fetches the public ingress base domain from the platform — used to display
// the operator-recommended CNAME target to the tenant (plain ingress base
// domain, not the slug-prefixed internal route).

export function useIngressBaseDomain() {
  return useQuery({
    queryKey: ['ingress-base-domain'],
    queryFn: () => apiFetch<{ data: { ingressBaseDomain: string } }>('/api/v1/platform/ingress-base-domain'),
    staleTime: 5 * 60 * 1000, // 5 min — rarely changes
  });
}

// ─── DNS Provider Groups ────────────────────────────────────────────────────

export interface DnsProviderGroup {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly nsHostnames: readonly string[] | null;
  readonly serverCount?: number;
  readonly domainCount?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function useDnsProviderGroups() {
  return useQuery({
    queryKey: ['dns-provider-groups'],
    queryFn: () => apiFetch<{ data: readonly DnsProviderGroup[] }>('/api/v1/dns-provider-groups'),
  });
}

export function useMigrateDomainDns(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ domainId, target_group_id }: { domainId: string; target_group_id: string }) =>
      apiFetch<{ data: Domain }>(
        `/api/v1/tenants/${tenantId}/domains/${domainId}/migrate-dns`,
        { method: 'POST', body: JSON.stringify({ target_group_id }) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domains', tenantId] });
    },
  });
}

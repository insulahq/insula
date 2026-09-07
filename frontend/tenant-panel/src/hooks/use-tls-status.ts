import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { CertificateReissueResponse, DomainTlsStatus } from '@insula/api-contracts';

/**
 * Live certificate state for a domain, straight from cert-manager.
 *
 * Polls while an order is in flight — issuance takes seconds to minutes
 * and the whole point of this view is that the tenant can watch it
 * instead of guessing.
 */
export function useDomainTlsStatus(tenantId: string | undefined, domainId: string | undefined) {
  return useQuery({
    queryKey: ['tls-status', tenantId, domainId],
    queryFn: () =>
      apiFetch<{ data: DomainTlsStatus }>(`/api/v1/tenants/${tenantId}/domains/${domainId}/tls`),
    enabled: Boolean(tenantId && domainId),
    refetchInterval: (query) => (query.state.data?.data?.state === 'issuing' ? 5_000 : false),
  });
}

/**
 * Break-glass: clear a wedged ACME challenge.
 *
 * Separate from reissue and NOT cooldown-gated — it orders no certificate, so
 * it spends none of Let's Encrypt's duplicate budget. It exists because the
 * reissue button is disabled for an hour after use, which is precisely when an
 * operator with a stuck certificate most needs a way to unstick it.
 */
export function useClearStuckValidation(tenantId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: { cleared: string[]; message: string } }>(
        `/api/v1/tenants/${tenantId}/domains/${domainId}/tls/clear-stuck-validation`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tls-status', tenantId, domainId] });
    },
  });
}

export function useReissueCertificate(tenantId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: CertificateReissueResponse }>(
        `/api/v1/tenants/${tenantId}/domains/${domainId}/tls/reissue`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tls-status', tenantId, domainId] });
      queryClient.invalidateQueries({ queryKey: ['domains', tenantId] });
      queryClient.invalidateQueries({ queryKey: ['task-center', 'me'] });
    },
  });
}

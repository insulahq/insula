import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

// Types come from @insula/api-contracts, never re-declared here. They WERE
// hand-declared in this file until 2026-09-03, which is unsafe by
// construction: a hand-written interface is self-consistent, so TypeScript
// cannot catch a field the server does not actually send (the defect that hid
// the dropped redirect field in PR #359). Re-exported so existing importers
// keep working.
export type {
  IntegrityFinding,
  NamespaceIntegrityReport,
  QuotaComparison,
} from '@insula/api-contracts';
import type { NamespaceIntegrityReport } from '@insula/api-contracts';

export function useTenantNamespaceIntegrity(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['namespace-integrity', tenantId],
    queryFn: () =>
      apiFetch<{ data: NamespaceIntegrityReport }>(`/api/v1/admin/tenants/${tenantId}/namespace-integrity`),
    enabled: Boolean(tenantId),
    refetchInterval: 60_000,
  });
}

export function useRepairTenantNamespace(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: NamespaceIntegrityReport }>(
        `/api/v1/admin/tenants/${tenantId}/namespace-integrity/repair`,
        { method: 'POST', body: JSON.stringify({}) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['namespace-integrity', tenantId] });
      qc.invalidateQueries({ queryKey: ['tenants', tenantId] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useSweepNamespaceIntegrity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: { checked: number; repaired: number; errored: number } }>(
        '/api/v1/admin/namespace-integrity/sweep',
        { method: 'POST', body: JSON.stringify({}) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['namespace-integrity'] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

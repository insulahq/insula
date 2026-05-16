import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export type IntegrityFinding =
  | 'namespace_missing'
  | 'pvc_missing'
  | 'resource_quota_missing'
  | 'network_policy_missing';

export interface NamespaceIntegrityReport {
  readonly tenantId: string;
  readonly name: string;
  readonly namespace: string;
  readonly findings: readonly IntegrityFinding[];
  readonly repaired: readonly IntegrityFinding[];
  readonly errors: readonly string[];
}

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

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface PerTenantResult {
  readonly id: string;
  readonly transitionId: string | null;
  readonly error?: string;
}

interface BulkResult {
  readonly data: {
    /** Always present after Phase A2; declared optional for backwards
     *  compatibility with older deployments that haven't rolled out
     *  the bulk-cascade rewrite yet. UI falls back to the static
     *  result modal when missing. */
    readonly bulkOpId?: string;
    readonly succeeded: readonly PerTenantResult[];
    readonly failed: readonly PerTenantResult[];
  };
}

export function useBulkSuspendTenants() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (tenantIds: readonly string[]) =>
      apiFetch<BulkResult>('/api/v1/admin/tenants/bulk', {
        method: 'POST',
        body: JSON.stringify({ tenant_ids: tenantIds, action: 'suspend' }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tenants'] });
    },
  });
}

export function useBulkReactivateTenants() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (tenantIds: readonly string[]) =>
      apiFetch<BulkResult>('/api/v1/admin/tenants/bulk', {
        method: 'POST',
        body: JSON.stringify({ tenant_ids: tenantIds, action: 'reactivate' }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tenants'] });
    },
  });
}

export function useBulkDeleteTenants() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (tenantIds: readonly string[]) =>
      apiFetch<BulkResult>('/api/v1/admin/tenants/bulk', {
        method: 'DELETE',
        body: JSON.stringify({ tenant_ids: tenantIds }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tenants'] });
    },
  });
}

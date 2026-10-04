import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { MigrateToWorkerResult } from '@insula/api-contracts';

interface MigrateResult {
  readonly data: MigrateToWorkerResult;
}

export function useMigrateTenantToWorker(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (nodeName: string) =>
      apiFetch<MigrateResult>(`/api/v1/admin/tenants/${tenantId}/migrate-to-worker`, {
        method: 'POST',
        body: JSON.stringify({ node_name: nodeName }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenants', tenantId] });
      qc.invalidateQueries({ queryKey: ['tenants'] });
      qc.invalidateQueries({ queryKey: ['cluster-nodes'] });
      // The pin moved: the placement view and its issue re-derive from it.
      qc.invalidateQueries({ queryKey: ['tenant-placement', tenantId] });
      qc.invalidateQueries({ queryKey: ['tenant-issues'] });
    },
  });
}

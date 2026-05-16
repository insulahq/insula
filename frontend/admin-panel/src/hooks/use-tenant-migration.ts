import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface MigrateResult {
  readonly data: {
    readonly tenantId: string;
    readonly previousWorker: string | null;
    readonly currentWorker: string;
    readonly deploymentsRestarted: number;
  };
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
    },
  });
}

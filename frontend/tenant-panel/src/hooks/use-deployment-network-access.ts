import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  DeploymentNetworkAccessInput,
  DeploymentNetworkAccessResponse,
} from '@k8s-hosting/api-contracts';

interface ApiEnvelope<T> {
  readonly data: T;
}

const KEY = (cid: string, did: string) => ['deployment-network-access', cid, did] as const;

export function useDeploymentNetworkAccess(tenantId: string | undefined, deploymentId: string | undefined) {
  return useQuery({
    queryKey: KEY(tenantId ?? '', deploymentId ?? ''),
    queryFn: async () => {
      const res = await apiFetch<ApiEnvelope<DeploymentNetworkAccessResponse | null>>(
        `/api/v1/tenants/${tenantId}/deployments/${deploymentId}/network-access`,
      );
      return res.data;
    },
    enabled: Boolean(tenantId && deploymentId),
  });
}

export function useUpsertDeploymentNetworkAccess(tenantId: string, deploymentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DeploymentNetworkAccessInput) => {
      const res = await apiFetch<ApiEnvelope<DeploymentNetworkAccessResponse>>(
        `/api/v1/tenants/${tenantId}/deployments/${deploymentId}/network-access`,
        { method: 'PATCH', body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(tenantId, deploymentId) }),
  });
}

export function useDeleteDeploymentNetworkAccess(tenantId: string, deploymentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await apiFetch<ApiEnvelope<{ deleted: boolean }>>(
        `/api/v1/tenants/${tenantId}/deployments/${deploymentId}/network-access`,
        { method: 'DELETE' },
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(tenantId, deploymentId) }),
  });
}

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { IngressRouteResponse } from '@k8s-hosting/api-contracts';

interface RouteListResponse {
  readonly data: readonly IngressRouteResponse[];
}

export function useIngressRoutes(tenantId: string | undefined, domainId: string | undefined) {
  return useQuery({
    queryKey: ['ingress-routes', tenantId, domainId],
    queryFn: () =>
      apiFetch<RouteListResponse>(
        `/api/v1/tenants/${tenantId}/domains/${domainId}/routes`,
      ),
    enabled: !!tenantId && !!domainId,
    staleTime: 30_000,
  });
}

export function useCreateIngressRoute(tenantId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { hostname: string; path?: string; deployment_id?: string | null }) =>
      apiFetch<{ data: IngressRouteResponse }>(
        `/api/v1/tenants/${tenantId}/domains/${domainId}/routes`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ingress-routes', tenantId, domainId] });
    },
  });
}

export function useUpdateIngressRoute(tenantId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ routeId, ...input }: { routeId: string; deployment_id?: string | null; service_port?: number | null }) =>
      apiFetch<{ data: IngressRouteResponse }>(
        `/api/v1/tenants/${tenantId}/domains/${domainId}/routes/${routeId}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ingress-routes', tenantId, domainId] });
    },
  });
}

export function useDeleteIngressRoute(tenantId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (routeId: string) =>
      apiFetch<void>(
        `/api/v1/tenants/${tenantId}/domains/${domainId}/routes/${routeId}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ingress-routes', tenantId, domainId] });
    },
  });
}

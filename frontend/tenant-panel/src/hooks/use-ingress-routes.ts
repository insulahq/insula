import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { IngressRouteResponse, UpdateIngressRouteInput } from '@insula/api-contracts';

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
      // These operations write or remove dns_records rows server-side, so the
      // domain's DNS Records list is stale the moment they succeed. Without this
      // the new records only appear after a full page reload.
      queryClient.invalidateQueries({ queryKey: ['dns-records'] });
    },
  });
}

export function useUpdateIngressRoute(tenantId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    // Input typed from the SHARED contract, not restated here. A hand-written
    // copy is self-consistent, so a field the API added (or renamed) is invisible
    // to the compiler and the PATCH silently drops it.
    mutationFn: ({ routeId, ...input }: { routeId: string } & UpdateIngressRouteInput) =>
      apiFetch<{ data: IngressRouteResponse }>(
        `/api/v1/tenants/${tenantId}/domains/${domainId}/routes/${routeId}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ingress-routes', tenantId, domainId] });
      queryClient.invalidateQueries({ queryKey: ['dns-records'] });
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
      queryClient.invalidateQueries({ queryKey: ['dns-records'] });
    },
  });
}

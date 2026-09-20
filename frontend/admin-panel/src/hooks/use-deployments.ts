import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateDeploymentRequest } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';
import type { PaginatedResponse } from '@/types/api';

export interface Deployment {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  // Nullable: custom deployments (ADR-036, source='custom') carry no
  // catalog entry. The XOR constraint at the DB layer keeps `source`
  // and this field consistent.
  readonly catalogEntryId: string | null;
  /** ADR-036 source discriminator. Defaults to 'catalog' on older
   *  rows that pre-date PR-1's migration. */
  readonly source?: 'catalog' | 'custom';
  readonly type: 'application' | 'runtime' | 'database' | 'service' | 'static';
  readonly status: string;
  /** Persistent error message when status='failed' (e.g. volume faulted, image pull error). */
  readonly lastError: string | null;
  /** Transient progress message while status='pending' (e.g. "1/3 replicas ready"). */
  readonly statusMessage: string | null;
  /** Cluster node currently hosting the first scheduled pod. */
  readonly currentNodeName: string | null;
  readonly replicaCount: number;
  readonly cpuRequest: string;
  readonly memoryRequest: string;
  readonly installedVersion: string | null;
  readonly targetVersion: string | null;
  readonly domainName: string | null;
  readonly storagePath: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** ADR-036 normalized spec for custom deployments. Null on catalog deployments. */
  readonly customSpec?: { allowRoot?: boolean; [key: string]: unknown } | null;
}

export function useDeployments(tenantId: string | undefined, type?: string) {
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  const qs = params.toString();
  const path = `/api/v1/tenants/${tenantId}/deployments${qs ? `?${qs}` : ''}`;

  return useQuery({
    queryKey: ['deployments', tenantId, type],
    queryFn: () => apiFetch<PaginatedResponse<Deployment>>(path),
    enabled: !!tenantId,
  });
}

// Cross-tenant deployment list backed by GET /admin/deployments
// (offset/page pagination). Joined to tenant + catalog entry for the
// admin Tenants → Workloads tab.
export interface AdminDeployment extends Deployment {
  readonly tenantName: string | null;
  readonly catalogEntryName: string | null;
  readonly catalogEntryCode: string | null;
  readonly catalogEntryType: string | null;
}

interface AdminDeploymentsResponse {
  readonly data: readonly AdminDeployment[];
  readonly pagination: {
    readonly page: number;
    readonly page_size: number;
    readonly total_count: number;
    readonly total_pages: number;
    readonly has_more: boolean;
  };
}

interface UseAllDeploymentsParams {
  readonly page?: number;
  readonly limit?: number;
  readonly tenantId?: string;
  readonly status?: string;
  readonly catalogEntryId?: string;
  readonly includeDeleted?: boolean;
  readonly search?: string;
}

export function useAllDeployments(params: UseAllDeploymentsParams = {}) {
  const { page = 1, limit = 20, tenantId, status, catalogEntryId, includeDeleted, search } = params;
  const qs = new URLSearchParams();
  qs.set('page', String(page));
  qs.set('limit', String(limit));
  if (tenantId) qs.set('tenant_id', tenantId);
  if (status) qs.set('status', status);
  if (catalogEntryId) qs.set('catalog_entry_id', catalogEntryId);
  if (includeDeleted) qs.set('include_deleted', 'true');
  if (search) qs.set('search', search);

  return useQuery({
    queryKey: ['deployments', 'admin', { page, limit, tenantId, status, catalogEntryId, includeDeleted, search }],
    queryFn: () => apiFetch<AdminDeploymentsResponse>(`/api/v1/admin/deployments?${qs.toString()}`),
  });
}

export function useDeployment(tenantId: string | undefined, deploymentId: string | undefined) {
  return useQuery({
    queryKey: ['deployments', tenantId, deploymentId],
    queryFn: () =>
      apiFetch<{ data: Deployment }>(`/api/v1/tenants/${tenantId}/deployments/${deploymentId}`),
    enabled: !!tenantId && !!deploymentId,
  });
}

// CreateDeploymentRequest comes from @insula/api-contracts (createDeploymentSchema) — the shape the backend parses with.

export function useCreateDeployment(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDeploymentRequest) =>
      apiFetch<{ data: Deployment }>(`/api/v1/tenants/${tenantId}/deployments`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments', tenantId] });
    },
  });
}

interface UpdateDeploymentInput {
  readonly name?: string;
  readonly replica_count?: number;
  readonly cpu_request?: string;
  readonly memory_request?: string;
  readonly status?: 'running' | 'stopped';
}

/**
 * Drop a previous failure from every cached view of one deployment, the moment
 * its redeploy starts.
 *
 * Same defect as the tenant panel's: the server forgets the failure before it
 * touches the cluster, but the panel renders what React Query holds, and
 * `invalidateQueries` only SCHEDULES a refetch. Until that lands the operator
 * sees the old error and a red FAILED chip over an application being replaced
 * as they look at it.
 *
 * The admin panel caches the same deployment under three keys with two
 * shapes — the per-tenant list, the paged admin list, and the single-row
 * detail — so this matches on the `deployments` prefix and tolerates `data`
 * being either an array or one row. Matching narrowly would leave whichever
 * view the operator happened to be on still showing the stale verdict.
 *
 * Only ever REMOVES a claim, so applying it optimistically cannot hide a real
 * failure: if the redeploy fails, the failure path writes a new error and the
 * refetch brings it back.
 */
function forgetFailureInCache(
  queryClient: ReturnType<typeof useQueryClient>,
  deploymentId: string,
): void {
  const forget = (row: Record<string, unknown>): Record<string, unknown> => {
    if (row.id !== deploymentId) return row;
    if (row.status !== 'failed' && !row.lastError && !row.statusMessage) return row;
    // 'pending', not 'running': the pods are coming back, and claiming they
    // are up would be the same overstatement in the other direction.
    return { ...row, status: row.status === 'failed' ? 'pending' : row.status, lastError: null, statusMessage: null };
  };
  queryClient.setQueriesData<unknown>(
    { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'deployments' },
    (prev: unknown) => {
      const env = prev as { data?: unknown } | undefined;
      if (!env || typeof env !== 'object' || !('data' in env)) return prev;
      const d = env.data;
      if (Array.isArray(d)) {
        let touched = false;
        const next = d.map((row) => {
          const out = forget(row as Record<string, unknown>);
          if (out !== row) touched = true;
          return out;
        });
        return touched ? { ...env, data: next } : prev;
      }
      if (d && typeof d === 'object') {
        const out = forget(d as Record<string, unknown>);
        return out === d ? prev : { ...env, data: out };
      }
      return prev;
    },
  );
}

export function useUpdateDeployment(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deploymentId, ...input }: UpdateDeploymentInput & { readonly deploymentId: string }) =>
      apiFetch<{ data: Deployment }>(`/api/v1/tenants/${tenantId}/deployments/${deploymentId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onMutate: ({ deploymentId }) => { forgetFailureInCache(queryClient, deploymentId); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments', tenantId] });
    },
  });
}

export function useDeleteDeployment(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deploymentId: string) =>
      apiFetch<void>(`/api/v1/tenants/${tenantId}/deployments/${deploymentId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments', tenantId] });
    },
  });
}

export function useRestartDeployment(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deploymentId: string) =>
      apiFetch(`/api/v1/tenants/${tenantId}/deployments/${deploymentId}/restart`, { method: 'POST' }),
    // The restart response carries no deployment, so the stale row has to be
    // corrected as the request goes out rather than when it comes back.
    onMutate: (deploymentId: string) => { forgetFailureInCache(queryClient, deploymentId); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
    },
  });
}

// Two modes:
//   string                 — fleet-wide filter by catalog_entry_id (running only)
//   readonly string[]      — explicit deployment_ids, force-restart any state
//   undefined              — fleet-wide all running deployments
export function useBulkRestartDeployments() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input?: string | readonly string[]) => {
      let body: Record<string, unknown> = {};
      if (Array.isArray(input)) {
        body = { deployment_ids: input };
      } else if (typeof input === 'string') {
        body = { catalog_entry_id: input };
      }
      return apiFetch('/api/v1/admin/deployments/bulk-restart', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
    },
  });
}

export function useSetCustomDeploymentAllowRoot(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deploymentId, allowRoot }: { deploymentId: string; allowRoot: boolean }) =>
      apiFetch<{ data: unknown }>(
        `/api/v1/admin/tenants/${tenantId}/custom-deployments/${deploymentId}/allow-root`,
        { method: 'PATCH', body: JSON.stringify({ allowRoot }) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments', tenantId] });
    },
  });
}

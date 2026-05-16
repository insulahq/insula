import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { Deployment, PaginatedResponse } from '@/types/api';

interface CreateDeploymentInput {
  readonly name: string;
  readonly catalog_entry_id: string;
  readonly replica_count?: number;
  readonly cpu_request?: string;
  readonly memory_request?: string;
  readonly configuration?: Record<string, unknown>;
  readonly version?: string;
  readonly storage_mode?: 'default' | 'custom';
  readonly storage_path?: string;
}

interface UpdateDeploymentInput {
  readonly status?: 'running' | 'stopped';
  readonly configuration?: Record<string, unknown>;
}

export function useDeployments(tenantId: string | undefined, options?: { refetchInterval?: number | false }) {
  return useQuery({
    queryKey: ['deployments', tenantId],
    queryFn: () => apiFetch<PaginatedResponse<Deployment>>(`/api/v1/tenants/${tenantId}/deployments?include_deleted=true`),
    enabled: Boolean(tenantId),
    refetchInterval: options?.refetchInterval,
  });
}

export function useCreateDeployment(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDeploymentInput) => {
      if (!tenantId) throw new Error('No tenant selected');
      return apiFetch<{ data: Deployment }>(`/api/v1/tenants/${tenantId}/deployments`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments', tenantId] });
    },
  });
}

export function useUpdateDeployment(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deploymentId, ...input }: UpdateDeploymentInput & { readonly deploymentId: string }) =>
      apiFetch<{ data: Deployment }>(`/api/v1/tenants/${tenantId}/deployments/${deploymentId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments', tenantId] });
    },
  });
}

export interface DeploymentLiveMetrics {
  readonly cpuUsed: number;
  readonly cpuRequest: string;
  readonly memoryUsedMi: number;
  readonly memoryRequest: string;
  readonly storageUsedBytes?: number;
  readonly storageUsedFormatted?: string;
}

export function useDeploymentLiveMetrics(tenantId: string | undefined, deploymentId: string | undefined) {
  return useQuery({
    queryKey: ['deployment-live-metrics', tenantId, deploymentId],
    queryFn: () => apiFetch<{ data: DeploymentLiveMetrics }>(`/api/v1/tenants/${tenantId}/deployments/${deploymentId}/live-metrics`),
    enabled: Boolean(tenantId && deploymentId),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export interface LogLine {
  readonly source: 'K8S' | 'APP';
  readonly text: string;
  readonly timestamp?: string;
  readonly level: 'info' | 'warning' | 'error';
}

export interface DeploymentLogs {
  readonly podName: string;
  readonly lines: readonly LogLine[];
  readonly terminationReason: string | null;
  readonly tailLines: number;
}

export function useDeploymentLogs(tenantId: string | undefined, deploymentId: string | undefined, enabled = false) {
  return useQuery({
    queryKey: ['deployment-logs', tenantId, deploymentId],
    queryFn: () => apiFetch<{ data: DeploymentLogs }>(`/api/v1/tenants/${tenantId}/deployments/${deploymentId}/logs?lines=200`),
    enabled: Boolean(tenantId && deploymentId) && enabled,
    staleTime: 10_000,
  });
}

export interface ResourceAvailability {
  readonly cpu: { readonly min: string; readonly max: string; readonly current: string; readonly planLimit: string };
  readonly memory: { readonly min: string; readonly max: string; readonly current: string; readonly planLimit: string };
}

export function useResourceAvailability(tenantId: string | undefined, deploymentId: string | undefined) {
  return useQuery({
    queryKey: ['resource-availability', tenantId, deploymentId],
    queryFn: () => apiFetch<{ data: ResourceAvailability }>(`/api/v1/tenants/${tenantId}/deployments/${deploymentId}/resource-availability`),
    enabled: Boolean(tenantId && deploymentId),
    staleTime: 30_000,
  });
}

export interface ResourceBreakdown {
  readonly total: { readonly cpu: string; readonly memory: string };
  readonly components: ReadonlyArray<{
    readonly name: string;
    readonly cpu: string;
    readonly memory: string;
    readonly weight: number | null;
    readonly pinned: boolean;
  }>;
  readonly warnings: readonly string[];
  readonly qosModel: { readonly cpu: 'burstable'; readonly memory: 'guaranteed' };
}

/** ADR-037: per-component CPU/memory allocation for a deployment. */
export function useResourceBreakdown(tenantId: string | undefined, deploymentId: string | undefined) {
  return useQuery({
    queryKey: ['resource-breakdown', tenantId, deploymentId],
    queryFn: () => apiFetch<{ data: ResourceBreakdown }>(`/api/v1/tenants/${tenantId}/deployments/${deploymentId}/resource-breakdown`),
    enabled: Boolean(tenantId && deploymentId),
    staleTime: 30_000,
  });
}

export function useUpdateDeploymentResources(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deploymentId, cpu_request, memory_request }: { readonly deploymentId: string; readonly cpu_request?: string; readonly memory_request?: string }) =>
      apiFetch<{ data: Deployment }>(`/api/v1/tenants/${tenantId}/deployments/${deploymentId}/resources`, {
        method: 'PATCH',
        body: JSON.stringify({ cpu_request, memory_request }),
      }),
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

interface DeploymentCredentials {
  readonly credentials: Record<string, string>;
  readonly connectionInfo: {
    readonly host?: string;
    readonly port?: number;
    readonly database?: string;
    readonly username?: string;
    readonly connectionUrl?: string;
  } | null;
  readonly generatedKeys: readonly string[];
}

export function useDeploymentCredentials(tenantId: string | undefined, deploymentId: string | undefined) {
  return useQuery({
    queryKey: ['deployment-credentials', tenantId, deploymentId],
    queryFn: () => apiFetch<{ data: DeploymentCredentials }>(
      `/api/v1/tenants/${tenantId}/deployments/${deploymentId}/credentials`
    ),
    enabled: Boolean(tenantId) && Boolean(deploymentId),
  });
}

export function useRestartDeployment(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deploymentId: string) =>
      apiFetch<{ data: { message: string } }>(
        `/api/v1/tenants/${tenantId}/deployments/${deploymentId}/restart`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments', tenantId] });
    },
  });
}

export function useRegenerateCredentials(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deploymentId, keys }: { deploymentId: string; keys?: string[] }) =>
      apiFetch<{ data: DeploymentCredentials }>(
        `/api/v1/tenants/${tenantId}/deployments/${deploymentId}/regenerate-credentials`,
        { method: 'POST', body: JSON.stringify({ keys }) }
      ),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['deployment-credentials', tenantId, variables.deploymentId] });
      queryClient.invalidateQueries({ queryKey: ['deployments', tenantId] });
    },
  });
}

export function useRestoreDeployment(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deploymentId: string) =>
      apiFetch<{ data: Deployment }>(`/api/v1/tenants/${tenantId}/deployments/${deploymentId}/restore`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments', tenantId] });
    },
  });
}

export function usePermanentDeleteDeployment(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deploymentId, deleteData }: { deploymentId: string; deleteData?: boolean }) => {
      const params = new URLSearchParams({ force: 'true' });
      if (deleteData) params.set('deleteData', 'true');
      return apiFetch<void>(`/api/v1/tenants/${tenantId}/deployments/${deploymentId}?${params.toString()}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments', tenantId] });
    },
  });
}

// ─── Database Management Hooks ──────────────────────────────────────────────

export interface DbDatabase {
  readonly name: string;
}

export interface DbUser {
  readonly username: string;
  readonly host: string;
  readonly databases?: readonly string[];
}

export function useDbDatabases(tenantId: string | undefined, deploymentId: string | undefined) {
  return useQuery({
    queryKey: ['db-databases', tenantId, deploymentId],
    queryFn: () =>
      apiFetch<{ data: readonly DbDatabase[] }>(
        `/api/v1/tenants/${tenantId}/deployments/${deploymentId}/databases`,
      ),
    enabled: Boolean(tenantId) && Boolean(deploymentId),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  });
}

export function useCreateDbDatabase(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deploymentId, name }: { deploymentId: string; name: string }) =>
      apiFetch<{ data: { name: string } }>(
        `/api/v1/tenants/${tenantId}/deployments/${deploymentId}/databases`,
        { method: 'POST', body: JSON.stringify({ name }) },
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['db-databases', tenantId, variables.deploymentId] });
    },
  });
}

export function useDropDbDatabase(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deploymentId, name }: { deploymentId: string; name: string }) =>
      apiFetch<void>(
        `/api/v1/tenants/${tenantId}/deployments/${deploymentId}/databases/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['db-databases', tenantId, variables.deploymentId] });
    },
  });
}

export function useDbUsers(tenantId: string | undefined, deploymentId: string | undefined) {
  return useQuery({
    queryKey: ['db-users', tenantId, deploymentId],
    queryFn: () =>
      apiFetch<{ data: readonly DbUser[] }>(
        `/api/v1/tenants/${tenantId}/deployments/${deploymentId}/db-users`,
      ),
    enabled: Boolean(tenantId) && Boolean(deploymentId),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  });
}

export function useCreateDbUser(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      deploymentId,
      username,
      password,
      database,
    }: {
      deploymentId: string;
      username: string;
      password: string;
      database?: string;
    }) =>
      apiFetch<{ data: { username: string } }>(
        `/api/v1/tenants/${tenantId}/deployments/${deploymentId}/db-users`,
        { method: 'POST', body: JSON.stringify({ username, password, database }) },
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['db-users', tenantId, variables.deploymentId] });
    },
  });
}

export function useDropDbUser(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deploymentId, username }: { deploymentId: string; username: string }) =>
      apiFetch<void>(
        `/api/v1/tenants/${tenantId}/deployments/${deploymentId}/db-users/${encodeURIComponent(username)}`,
        { method: 'DELETE' },
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['db-users', tenantId, variables.deploymentId] });
    },
  });
}

// ─── Resource Usage ─────────────────────────────────────────────────────────

export interface ResourceUsage {
  readonly cpu: { readonly used: string; readonly limit: string };
  readonly memory: { readonly used: string; readonly limit: string };
  readonly storage: { readonly used: string; readonly limit: string };
}

export function useResourceUsage(tenantId: string | null | undefined) {
  return useQuery({
    queryKey: ['resource-usage', tenantId],
    queryFn: () =>
      apiFetch<{ data: ResourceUsage }>(
        `/api/v1/tenants/${tenantId}/resource-usage`,
      ),
    enabled: Boolean(tenantId),
    refetchInterval: 15_000,
  });
}

// ─── Delete Preview ──────────────────────────────────────────────────────────

export interface DeletePreviewRoute {
  readonly id: string;
  readonly hostname: string;
  readonly path: string;
  readonly domainName: string;
}

export interface DeletePreviewResponse {
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly affectedRoutes: readonly DeletePreviewRoute[];
}

export function useDeletePreview(tenantId: string | undefined, deploymentId: string | undefined) {
  return useQuery({
    queryKey: ['delete-preview', tenantId, deploymentId],
    queryFn: () => apiFetch<{ data: DeletePreviewResponse }>(`/api/v1/tenants/${tenantId}/deployments/${deploymentId}/delete-preview`),
    enabled: Boolean(tenantId && deploymentId),
  });
}

// ─── Storage Folders ─────────────────────────────────────────────────────────

export interface StorageFolder {
  readonly name: string;
  readonly path: string;
  readonly isEmpty: boolean;
  readonly usedByDeployment: string | null;
}

export interface StorageFolderList {
  readonly basePath: string;
  readonly folders: readonly StorageFolder[];
}

export function useStorageFolders(tenantId: string | undefined, entryType: string | undefined, entryCode: string | undefined) {
  return useQuery({
    queryKey: ['storage-folders', tenantId, entryType, entryCode],
    queryFn: () => apiFetch<{ data: StorageFolderList }>(`/api/v1/tenants/${tenantId}/deployments/storage-folders?type=${entryType}&code=${entryCode}`),
    enabled: Boolean(tenantId && entryType && entryCode),
  });
}

export function useSetDbUserPassword(tenantId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      deploymentId,
      username,
      password,
    }: {
      deploymentId: string;
      username: string;
      password: string;
    }) =>
      apiFetch<{ data: { message: string } }>(
        `/api/v1/tenants/${tenantId}/deployments/${deploymentId}/db-users/${encodeURIComponent(username)}/password`,
        { method: 'POST', body: JSON.stringify({ password }) },
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['db-users', tenantId, variables.deploymentId] });
    },
  });
}

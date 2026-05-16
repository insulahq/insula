import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RouteRedirectSettings {
  readonly forceHttps: boolean;
  readonly wwwRedirect: 'none' | 'add-www' | 'remove-www';
  readonly customRedirectUrl: string | null;
}

export interface RouteSecuritySettings {
  readonly ipAllowlist: string | null;
  readonly rateLimitRps: number | null;
  readonly rateLimitConnections: number | null;
  readonly rateLimitBurst: number | null;
  readonly wafEnabled: boolean;
  readonly wafOwaspCoreRules: boolean;
  readonly wafAnomalyThreshold: number;
  readonly wafExcludedRuleIds: string | null;
}

export interface RouteAdvancedSettings {
  readonly customErrorCodes: string | null;
  readonly customErrorPath: string | null;
  readonly additionalHeaders: Record<string, string> | null;
}

export interface RouteDetailResponse {
  readonly id: string;
  readonly domainId: string;
  readonly hostname: string;
  readonly path: string;
  readonly deploymentId: string | null;
  readonly ingressCname: string;
  readonly nodeHostname: string | null;
  readonly isApex: number;
  readonly tlsMode: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly forceHttps: boolean;
  readonly wwwRedirect: 'none' | 'add-www' | 'remove-www';
  readonly customRedirectUrl: string | null;
  readonly ipAllowlist: string | null;
  readonly rateLimitRps: number | null;
  readonly rateLimitConnections: number | null;
  readonly rateLimitBurst: number | null;
  readonly wafEnabled: boolean;
  readonly wafOwaspCoreRules: boolean;
  readonly wafAnomalyThreshold: number;
  readonly wafExcludedRuleIds: string | null;
  readonly customErrorCodes: string | null;
  readonly customErrorPath: string | null;
  readonly additionalHeaders: Record<string, string> | null;
}

export interface ProtectedDir {
  readonly id: string;
  readonly routeId: string;
  readonly path: string;
  readonly realm: string;
  readonly enabled: boolean;
  readonly userCount: number;
  readonly createdAt: string;
}

export interface DirUser {
  readonly id: string;
  readonly dirId: string;
  readonly username: string;
  readonly enabled: boolean;
  readonly createdAt: string;
}

export interface WafLogEntry {
  readonly id: string;
  readonly routeId: string;
  readonly ruleId: string;
  readonly severity: string;
  readonly message: string;
  readonly requestUri: string | null;
  readonly requestMethod: string | null;
  readonly sourceIp: string | null;
  readonly createdAt: string;
}

// ─── Route Detail ───────────────────────────────────────────────────────────

function routeBasePath(tenantId: string, routeId: string) {
  return `/api/v1/tenants/${tenantId}/routes/${routeId}`;
}

export function useRouteDetail(tenantId: string | undefined, routeId: string | undefined) {
  return useQuery({
    queryKey: ['route-detail', tenantId, routeId],
    queryFn: () =>
      apiFetch<{ data: RouteDetailResponse }>(routeBasePath(tenantId!, routeId!)),
    enabled: Boolean(tenantId && routeId),
  });
}

// ─── Redirect Settings ──────────────────────────────────────────────────────

export function useUpdateRouteRedirects(tenantId: string | undefined, routeId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      readonly force_https?: boolean;
      readonly www_redirect?: 'none' | 'add-www' | 'remove-www';
      readonly custom_redirect_url?: string | null;
    }) =>
      apiFetch<{ data: RouteDetailResponse }>(
        `${routeBasePath(tenantId!, routeId!)}/redirects`,
        { method: 'PATCH', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['route-detail', tenantId, routeId] });
    },
  });
}

// ─── Security Settings ──────────────────────────────────────────────────────

export function useUpdateRouteSecurity(tenantId: string | undefined, routeId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      readonly ip_allowlist?: string | null;
      readonly rate_limit_rps?: number | null;
      readonly rate_limit_connections?: number | null;
      readonly rate_limit_burst?: number | null;
      readonly waf_enabled?: boolean;
      readonly waf_owasp_core_rules?: boolean;
      readonly waf_anomaly_threshold?: number;
      readonly waf_excluded_rule_ids?: string | null;
    }) =>
      apiFetch<{ data: RouteDetailResponse }>(
        `${routeBasePath(tenantId!, routeId!)}/security`,
        { method: 'PATCH', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['route-detail', tenantId, routeId] });
    },
  });
}

// ─── Advanced Settings ──────────────────────────────────────────────────────

export function useUpdateRouteAdvanced(tenantId: string | undefined, routeId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      readonly custom_error_codes?: string | null;
      readonly custom_error_path?: string | null;
      readonly additional_headers?: Record<string, string> | null;
    }) =>
      apiFetch<{ data: RouteDetailResponse }>(
        `${routeBasePath(tenantId!, routeId!)}/advanced`,
        { method: 'PATCH', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['route-detail', tenantId, routeId] });
    },
  });
}

// ─── Protected Directories ──────────────────────────────────────────────────

function protectedDirsBasePath(tenantId: string, routeId: string) {
  return `${routeBasePath(tenantId, routeId)}/protected-dirs`;
}

export function useProtectedDirs(tenantId: string | undefined, routeId: string | undefined) {
  return useQuery({
    queryKey: ['protected-dirs', tenantId, routeId],
    queryFn: () =>
      apiFetch<{ data: readonly ProtectedDir[] }>(
        protectedDirsBasePath(tenantId!, routeId!),
      ),
    enabled: Boolean(tenantId && routeId),
  });
}

export function useCreateProtectedDir(tenantId: string | undefined, routeId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { readonly path: string; readonly realm: string }) =>
      apiFetch<{ data: ProtectedDir }>(
        protectedDirsBasePath(tenantId!, routeId!),
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['protected-dirs', tenantId, routeId] });
    },
  });
}

export function useUpdateProtectedDir(tenantId: string | undefined, routeId: string | undefined, dirId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { readonly realm?: string; readonly enabled?: boolean }) =>
      apiFetch<{ data: ProtectedDir }>(
        `${protectedDirsBasePath(tenantId!, routeId!)}/${dirId}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['protected-dirs', tenantId, routeId] });
    },
  });
}

export function useDeleteProtectedDir(tenantId: string | undefined, routeId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (dirId: string) =>
      apiFetch<void>(
        `${protectedDirsBasePath(tenantId!, routeId!)}/${dirId}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['protected-dirs', tenantId, routeId] });
    },
  });
}

// ─── Directory Users ────────────────────────────────────────────────────────

function dirUsersBasePath(tenantId: string, routeId: string, dirId: string) {
  return `${protectedDirsBasePath(tenantId, routeId)}/${dirId}/users`;
}

export function useDirUsers(tenantId: string | undefined, routeId: string | undefined, dirId: string) {
  return useQuery({
    queryKey: ['dir-users', tenantId, routeId, dirId],
    queryFn: () =>
      apiFetch<{ data: readonly DirUser[] }>(
        dirUsersBasePath(tenantId!, routeId!, dirId),
      ),
    enabled: Boolean(tenantId && routeId && dirId),
  });
}

export function useCreateDirUser(tenantId: string | undefined, routeId: string | undefined, dirId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { readonly username: string; readonly password: string }) =>
      apiFetch<{ data: DirUser }>(
        dirUsersBasePath(tenantId!, routeId!, dirId),
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dir-users', tenantId, routeId, dirId] });
      queryClient.invalidateQueries({ queryKey: ['protected-dirs', tenantId, routeId] });
    },
  });
}

export function useDeleteDirUser(tenantId: string | undefined, routeId: string | undefined, dirId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<void>(
        `${dirUsersBasePath(tenantId!, routeId!, dirId)}/${userId}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dir-users', tenantId, routeId, dirId] });
      queryClient.invalidateQueries({ queryKey: ['protected-dirs', tenantId, routeId] });
    },
  });
}

export function useToggleDirUser(tenantId: string | undefined, routeId: string | undefined, dirId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ userId, enabled }: { readonly userId: string; readonly enabled: boolean }) =>
      apiFetch<{ data: DirUser }>(
        `${dirUsersBasePath(tenantId!, routeId!, dirId)}/${userId}/toggle`,
        { method: 'POST', body: JSON.stringify({ enabled }) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dir-users', tenantId, routeId, dirId] });
    },
  });
}

// ─── WAF Logs ───────────────────────────────────────────────────────────────

export function useRouteWafLogs(tenantId: string | undefined, routeId: string | undefined) {
  return useQuery({
    queryKey: ['route-waf-logs', tenantId, routeId],
    queryFn: () =>
      apiFetch<{ data: readonly WafLogEntry[] }>(
        `${routeBasePath(tenantId!, routeId!)}/waf-logs`,
      ),
    enabled: Boolean(tenantId && routeId),
  });
}

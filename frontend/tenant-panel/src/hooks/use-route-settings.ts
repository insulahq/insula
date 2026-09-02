import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { IngressRouteResponse, WafRuleExclusionScope } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';

// ─── Types ──────────────────────────────────────────────────────────────────

// The route detail/settings shape is the contract's, not a local restatement.
// It used to be a hand-written interface here, and four of its field names were
// wrong — customRedirectUrl, rateLimitBurst, wafOwaspCoreRules and
// wafExcludedRuleIds do not exist in any API response. TypeScript could not
// catch that, because the local type was self-consistent: the page read
// `route.customRedirectUrl`, got undefined, and rendered an empty box.
// Deriving from @insula/api-contracts makes the next drift a compile error.
export type RouteDetailResponse = IngressRouteResponse;

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
      readonly redirect_url?: string | null;
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
      readonly rate_limit_burst_multiplier?: number | null;
      // Only `waf_enabled` is mutated from the tenant UI under the
      // shared-sidecar architecture. The other waf_* fields the backend
      // Zod schema accepts (waf_owasp_crs, waf_anomaly_threshold,
      // waf_excluded_rules) have no runtime effect — they're left in
      // the contract for the admin path + a future per-route WAF re-
      // enable, but never sent from this hook.
      readonly waf_enabled?: boolean;
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
      // HSTS. Sent as a group from the HSTS section; the backend still
      // validates the preload contract against the merged row so a partial
      // update from any other caller cannot produce an invalid policy.
      readonly hsts_enabled?: boolean;
      readonly hsts_max_age?: number;
      readonly hsts_include_subdomains?: boolean;
      readonly hsts_preload?: boolean;
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

// ─── WAF Exclusions (B2 — tenant-scoped) ────────────────────────────────────

export interface WafRuleExclusionEntry {
  readonly id: string;
  readonly ruleId: string;
  readonly hostnameRegex: string;
  readonly scope: WafRuleExclusionScope;
  readonly reason: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly disabled: boolean;
  readonly tenantId: string | null;
  readonly routeId: string | null;
}

export function useRouteWafExclusions(
  tenantId: string | undefined,
  routeId: string | undefined,
) {
  return useQuery({
    queryKey: ['route-waf-exclusions', tenantId, routeId],
    queryFn: () =>
      apiFetch<{ data: { exclusions: readonly WafRuleExclusionEntry[] } }>(
        `${routeBasePath(tenantId!, routeId!)}/waf-exclusions`,
      ),
    enabled: Boolean(tenantId && routeId),
  });
}

export function useCreateRouteWafExclusion(
  tenantId: string | undefined,
  routeId: string | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      readonly ruleId: string;
      readonly scope: WafRuleExclusionScope;
      readonly reason: string;
    }) =>
      apiFetch<{ data: WafRuleExclusionEntry }>(
        `${routeBasePath(tenantId!, routeId!)}/waf-exclusions`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['route-waf-exclusions', tenantId, routeId] });
    },
  });
}

export function useDeleteRouteWafExclusion(
  tenantId: string | undefined,
  routeId: string | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: { deleted: true } }>(
        `${routeBasePath(tenantId!, routeId!)}/waf-exclusions/${id}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['route-waf-exclusions', tenantId, routeId] });
    },
  });
}

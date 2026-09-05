import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateOidcProviderInput } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';

// ─── Provider Types ──────────────────────────────────────────────────────────

export interface OidcProvider {
  readonly id: string;
  readonly displayName: string;
  readonly issuerUrl: string;
  readonly tenantId: string;
  readonly panelScope: 'admin' | 'tenant';
  readonly enabled: boolean;
  readonly backchannelLogoutEnabled: boolean;
  readonly displayOrder: number;
  readonly discoveryMetadata: Record<string, unknown> | null;
  readonly autoProvision: boolean;
  readonly defaultRole: string | null;
  readonly additionalClaims: string[] | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OidcGlobalSettings {
  readonly disableLocalAuthAdmin: boolean;
  readonly disableLocalAuthTenant: boolean;
  readonly hasBreakGlassSecret: boolean;
  readonly proxyProtectAdmin: boolean;
  readonly proxyProtectTenant: boolean;
  readonly breakGlassPath: string | null;
}

export interface OidcTestResult {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly backchannel_logout_supported: boolean;
  readonly keys_count: number;
  readonly status: string;
}

// ─── Provider Hooks ──────────────────────────────────────────────────────────

export function useOidcProviders() {
  return useQuery({
    queryKey: ['oidc-providers'],
    queryFn: () => apiFetch<{ data: readonly OidcProvider[] }>('/api/v1/admin/oidc/providers'),
  });
}

/**
 * The request shape comes from the shared contract — never re-declared here.
 *
 * This file used to carry its own `CreateProviderInput` with `tenant_id` /
 * `tenant_secret` while the API required `client_id` / `client_secret`. The
 * local type was internally consistent, so tsc was happy and the panel simply
 * could not add an OIDC provider: create 400'd, and edit returned 200 while
 * silently not writing the client id or secret.
 */
type CreateProviderInput = CreateOidcProviderInput;

export function useCreateOidcProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProviderInput) =>
      apiFetch<{ data: OidcProvider }>('/api/v1/admin/oidc/providers', {
        method: 'POST', body: JSON.stringify(input),
      }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['oidc-providers'] }); },
  });
}

export function useUpdateOidcProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<CreateProviderInput> & { id: string }) =>
      apiFetch<{ data: OidcProvider }>(`/api/v1/admin/oidc/providers/${id}`, {
        method: 'PATCH', body: JSON.stringify(input),
      }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['oidc-providers'] }); },
  });
}

export function useDeleteOidcProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/admin/oidc/providers/${id}`, { method: 'DELETE' }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['oidc-providers'] }); },
  });
}

export function useTestOidcProvider() {
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: OidcTestResult }>(`/api/v1/admin/oidc/providers/${id}/test`, { method: 'POST' }),
  });
}

// ─── Global Settings Hooks ───────────────────────────────────────────────────

export function useOidcGlobalSettings() {
  return useQuery({
    queryKey: ['oidc-global-settings'],
    queryFn: () => apiFetch<{ data: OidcGlobalSettings }>('/api/v1/admin/oidc/settings'),
  });
}

interface SaveGlobalSettingsInput {
  readonly disable_local_auth_admin?: boolean;
  readonly disable_local_auth_tenant?: boolean;
  readonly break_glass_secret?: string;
  readonly proxy_protect_admin?: boolean;
  readonly proxy_protect_tenant?: boolean;
}

export function useSaveOidcGlobalSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveGlobalSettingsInput) =>
      apiFetch<{ data: OidcGlobalSettings }>('/api/v1/admin/oidc/settings', {
        method: 'PUT', body: JSON.stringify(input),
      }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['oidc-global-settings'] }); },
  });
}

export function useRegenerateBreakGlass() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: { breakGlassPath: string } }>('/api/v1/admin/oidc/regenerate-break-glass', {
        method: 'POST',
      }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['oidc-global-settings'] }); },
  });
}

export function useRegenerateCookieSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: { regenerated: boolean } }>('/api/v1/admin/oidc/regenerate-cookie-secret', {
        method: 'POST',
      }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['oidc-global-settings'] }); },
  });
}

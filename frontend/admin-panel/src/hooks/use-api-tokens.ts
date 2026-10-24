import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateMcpPatInput, CreatedMcpPat, McpAgentSettings, McpConsentDecision, McpConsentRequest, McpConsentResult,
  McpPlatformConnections, McpTokenList,
} from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';

const TOKENS_KEY = ['api-tokens'] as const;
const PLATFORM_AGENTS_KEY = ['mcp-connections'] as const;

/**
 * The signed-in user's API tokens (PATs), their connected AI agents and the MCP
 * endpoint URL. Polled, because the header shows whether an agent is connected
 * and an agent connects from another window.
 */
export function useApiTokens(options: { readonly poll?: boolean } = {}) {
  return useQuery({
    queryKey: TOKENS_KEY,
    queryFn: () => apiFetch<{ data: McpTokenList }>('/api/v1/admin/mcp/tokens').then((r) => r.data),
    refetchInterval: options.poll ? 60_000 : false,
  });
}

/** Security → AI agents: every connected agent on the platform, and the tenant switch. */
export function usePlatformAgents() {
  return useQuery({
    queryKey: PLATFORM_AGENTS_KEY,
    queryFn: () => apiFetch<{ data: McpPlatformConnections }>('/api/v1/admin/mcp/connections').then((r) => r.data),
    refetchInterval: 60_000,
  });
}

/** Disconnect an agent — the user's own, or (super_admin/admin) anyone's. */
export function useRevokeConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<{ data: { revoked: boolean } }>(`/api/v1/admin/mcp/connections/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TOKENS_KEY });
      void qc.invalidateQueries({ queryKey: PLATFORM_AGENTS_KEY });
    },
  });
}

export function useUpdateAgentSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: McpAgentSettings) => apiFetch<{ data: { tenantAgentsEnabled: boolean; disconnected: number } }>(
      '/api/v1/admin/mcp/settings',
      { method: 'PATCH', body: JSON.stringify(input) },
    ).then((r) => r.data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: PLATFORM_AGENTS_KEY }); },
  });
}

export function useCreateApiToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMcpPatInput) => apiFetch<{ data: CreatedMcpPat }>('/api/v1/admin/mcp/tokens', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: TOKENS_KEY }); },
  });
}

export function useRevokeApiToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<{ data: { revoked: boolean } }>(`/api/v1/admin/mcp/tokens/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: TOKENS_KEY }); },
  });
}

/** A pending OAuth authorization, for the consent page. */
export function useConsentRequest(id: string | null) {
  return useQuery({
    queryKey: ['oauth-consent', id],
    enabled: Boolean(id),
    retry: false,
    queryFn: () => apiFetch<{ data: McpConsentRequest }>(`/api/v1/oauth/requests/${encodeURIComponent(id ?? '')}`)
      .then((r) => r.data),
  });
}

export function useConsentDecision(id: string) {
  return useMutation({
    mutationFn: (decision: McpConsentDecision) => apiFetch<{ data: McpConsentResult }>(
      `/api/v1/oauth/requests/${encodeURIComponent(id)}/decision`,
      { method: 'POST', body: JSON.stringify(decision) },
    ).then((r) => r.data),
  });
}

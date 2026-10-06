import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateMcpPatInput, CreatedMcpPat, McpConsentDecision, McpConsentRequest, McpConsentResult, McpTokenList,
} from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';

const TOKENS_KEY = ['api-tokens'] as const;

/** The signed-in user's API tokens (PATs + OAuth clients) and the MCP endpoint URL. */
export function useApiTokens() {
  return useQuery({
    queryKey: TOKENS_KEY,
    queryFn: () => apiFetch<{ data: McpTokenList }>('/api/v1/admin/mcp/tokens').then((r) => r.data),
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

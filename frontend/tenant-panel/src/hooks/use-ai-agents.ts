import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  McpConsentDecision, McpConsentRequest, McpConsentResult, TenantMcpAgents,
} from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';
import { useTenantContext } from '@/hooks/use-tenant-context';

const agentsKey = (tenantId: string | null) => ['ai-agents', tenantId] as const;

/**
 * The AI agents connected to the tenant panel that the signed-in user may see
 * (their own, or every agent of the tenant for a tenant_admin), the MCP
 * address, and whether the operator allows tenant agents. Polled: the header
 * shows a connected agent, and an agent connects from another window.
 */
export function useTenantAgents(options: { readonly poll?: boolean } = {}) {
  const { tenantId } = useTenantContext();
  return useQuery({
    queryKey: agentsKey(tenantId),
    enabled: Boolean(tenantId),
    queryFn: () => apiFetch<{ data: TenantMcpAgents }>(`/api/v1/tenants/${encodeURIComponent(tenantId ?? '')}/mcp-agents`)
      .then((r) => r.data),
    refetchInterval: options.poll ? 60_000 : false,
  });
}

export function useRevokeTenantAgent() {
  const qc = useQueryClient();
  const { tenantId } = useTenantContext();
  return useMutation({
    mutationFn: (id: string) => apiFetch<{ data: { revoked: boolean } }>(
      `/api/v1/tenants/${encodeURIComponent(tenantId ?? '')}/mcp-agents/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: agentsKey(tenantId) }); },
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

/**
 * F4 — DB-backed WAF rule exclusion hooks.
 *
 *   GET    /admin/security/waf-rule-exclusions[?includeDisabled=true]
 *   POST   /admin/security/waf-rule-exclusions
 *   PATCH  /admin/security/waf-rule-exclusions/:id
 *   DELETE /admin/security/waf-rule-exclusions/:id
 *
 * After every mutation the backend triggers an inline reconciler pass
 * that patches the modsec-crs-exclusions-dynamic ConfigMap and rolls
 * the modsec-crs Deployment. The operator sees the new rule active in
 * ~10s (pod rolling restart time).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  CreateWafRuleExclusionRequest,
  UpdateWafRuleExclusionRequest,
  WafRuleExclusion,
  WafRuleExclusionAdminListResponse,
} from '@insula/api-contracts';

interface Envelope<T> {
  readonly data: T;
}

// Admin list response includes the LEFT-JOINed tenants.name so the
// Tenant column can render the tenant's display name with a link.
// Tenant-scoped rows have non-null tenantId/routeId/tenantName; admin-
// scoped rows surface tenantName=null and the column renders "—".
export function useWafRuleExclusions(opts: { includeDisabled?: boolean } = {}) {
  const qs = opts.includeDisabled ? '?includeDisabled=true' : '';
  return useQuery<Envelope<WafRuleExclusionAdminListResponse>>({
    queryKey: ['waf-rule-exclusions', { includeDisabled: !!opts.includeDisabled }],
    queryFn: () => apiFetch(`/api/v1/admin/security/waf-rule-exclusions${qs}`),
    staleTime: 5_000,
  });
}

export function useCreateWafRuleExclusion() {
  const qc = useQueryClient();
  return useMutation<Envelope<WafRuleExclusion>, Error, CreateWafRuleExclusionRequest>({
    mutationFn: (body) =>
      apiFetch('/api/v1/admin/security/waf-rule-exclusions', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['waf-rule-exclusions'] });
    },
  });
}

export function useUpdateWafRuleExclusion() {
  const qc = useQueryClient();
  return useMutation<
    Envelope<WafRuleExclusion>,
    Error,
    { id: string; patch: UpdateWafRuleExclusionRequest }
  >({
    mutationFn: ({ id, patch }) =>
      apiFetch(`/api/v1/admin/security/waf-rule-exclusions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['waf-rule-exclusions'] });
    },
  });
}

export function useDeleteWafRuleExclusion() {
  const qc = useQueryClient();
  return useMutation<Envelope<{ message: string; id: string }>, Error, string>({
    mutationFn: (id) =>
      apiFetch(`/api/v1/admin/security/waf-rule-exclusions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['waf-rule-exclusions'] });
    },
  });
}

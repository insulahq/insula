/**
 * WAF event retention + the "would block" summary.
 *
 *   GET   /admin/security/waf-events/summary  — events grouped by host, rule and path (WAF Events filters)
 *   GET   /admin/security/waf-log-settings    — retention, ceilings, what is stored
 *   PATCH /admin/security/waf-log-settings    — { retentionDays }
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  PatchWafLogSettingsRequest,
  WafEventsQuery,
  WafLogSettings,
  WafLogSummaryResponse,
} from '@insula/api-contracts';

interface Envelope<T> {
  readonly data: T;
}

export function useWafEventsSummary(query: WafEventsQuery, enabled: boolean) {
  const params = new URLSearchParams();
  if (query.ruleId) params.set('ruleId', query.ruleId);
  if (query.severity) params.set('severity', query.severity);
  if (query.host) params.set('host', query.host);
  if (query.sourceIp) params.set('sourceIp', query.sourceIp);
  if (query.scope) params.set('scope', query.scope);
  if (typeof query.sinceSeconds === 'number') params.set('sinceSeconds', String(query.sinceSeconds));
  if (query.fromTime) params.set('fromTime', query.fromTime);
  if (query.toTime) params.set('toTime', query.toTime);
  const qs = params.toString();
  return useQuery<Envelope<WafLogSummaryResponse>>({
    queryKey: ['waf-events-summary', qs],
    queryFn: () => apiFetch(`/api/v1/admin/security/waf-events/summary${qs ? `?${qs}` : ''}`),
    enabled,
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
}

export function useWafLogSettings() {
  return useQuery<Envelope<WafLogSettings>>({
    queryKey: ['waf-log-settings'],
    queryFn: () => apiFetch('/api/v1/admin/security/waf-log-settings'),
  });
}

export function usePatchWafLogSettings() {
  const qc = useQueryClient();
  return useMutation<Envelope<WafLogSettings>, Error, PatchWafLogSettingsRequest>({
    mutationFn: (body) => apiFetch('/api/v1/admin/security/waf-log-settings', { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: (res) => { qc.setQueryData(['waf-log-settings'], res); },
  });
}

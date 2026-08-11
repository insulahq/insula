import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  DnsApexDriftReport,
  FixDnsApexDriftResponse,
} from '@insula/api-contracts';

/**
 * Apex DNS drift.
 *
 * The report read is cheap (a stored document) and safe to poll — it never
 * touches a DNS provider. The scan is the expensive one: it walks every
 * primary-mode zone, so it is only ever run when the operator asks for it or
 * on the backend's hourly schedule.
 */

export const DNS_APEX_DRIFT_QUERY_KEY = ['dns-apex-drift'] as const;

interface ReportResponse {
  readonly data: DnsApexDriftReport | null;
}

/** Latest stored report. `data` is null when no scan has ever run. */
export function useDnsApexDriftReport() {
  return useQuery({
    queryKey: DNS_APEX_DRIFT_QUERY_KEY,
    queryFn: () => apiFetch<ReportResponse>('/api/v1/admin/dns/apex-drift'),
    // Slow: drift only changes when cluster ingress membership changes or a
    // scan runs. Polling harder would just add load for no new information.
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });
}

/** Run a scan now. Read-only — never repairs. */
export function useScanDnsApexDrift() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<ReportResponse>('/api/v1/admin/dns/apex-drift/scan', { method: 'POST' }),
    onSuccess: (result) => {
      // Seed the cache with the fresh report so the banner and modal update
      // without a second round-trip.
      qc.setQueryData(DNS_APEX_DRIFT_QUERY_KEY, result);
    },
  });
}

export interface FixDriftVars {
  readonly domainIds?: readonly string[];
  readonly all?: boolean;
}

/**
 * Start an additive repair. Resolves with the task id — the caller opens the
 * progress modal; the work itself runs server-side under the task center.
 */
export function useFixDnsApexDrift() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: FixDriftVars) =>
      apiFetch<FixDnsApexDriftResponse>('/api/v1/admin/dns/apex-drift/fix', {
        method: 'POST',
        body: JSON.stringify(
          vars.all ? { all: true } : { domainIds: vars.domainIds ?? [] },
        ),
      }),
    onSuccess: () => {
      // The backend re-scans when the fix finishes; invalidate so the banner
      // picks that up rather than showing pre-fix drift.
      void qc.invalidateQueries({ queryKey: DNS_APEX_DRIFT_QUERY_KEY });
    },
  });
}

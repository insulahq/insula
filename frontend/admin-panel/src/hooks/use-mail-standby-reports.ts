import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { StandbyReportsResponse } from '@k8s-hosting/api-contracts';

interface StandbyReportsEnvelope {
  readonly data: StandbyReportsResponse;
}

export const STANDBY_REPORTS_KEY = ['mail', 'standby-reports'] as const;

/**
 * Live per-node freshness for the mail-stack-standby-replicate
 * DaemonSet. Refreshes every 30s — same DaemonSet loop cadence is
 * 5 min, so a faster refetch just keeps the age counter ticking
 * in the operator's view without wasting backend cycles.
 */
export function useMailStandbyReports() {
  return useQuery({
    queryKey: STANDBY_REPORTS_KEY,
    queryFn: () =>
      apiFetch<StandbyReportsEnvelope>('/api/v1/admin/mail/standby-reports'),
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  });
}

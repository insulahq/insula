import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  TrafficFrame, TrafficMetric, TrafficScope, TrafficSubject, TrafficBackupMode, TrafficDirection,
} from '@insula/api-contracts';

export interface TrafficSeriesParams {
  readonly from: Date;
  readonly to: Date;
  readonly scope: TrafficScope;
  readonly subject?: string;
  readonly pod?: string;
  readonly metric: TrafficMetric;
  readonly direction: TrafficDirection;
  readonly backups: TrafficBackupMode;
  /**
   * Ask the TENANT endpoints for this tenant instead of the admin ones: the
   * server then confines every scope to the tenant's namespace, so a route
   * or pod list can never show another tenant's subjects.
   */
  readonly tenantId?: string;
}

function base(tenantId: string | undefined): string {
  return tenantId ? `/api/v1/tenants/${encodeURIComponent(tenantId)}/traffic` : '/api/v1/admin/monitoring/traffic';
}

function toQuery(p: TrafficSeriesParams): string {
  const q = new URLSearchParams({
    from: p.from.toISOString(),
    to: p.to.toISOString(),
    scope: p.scope,
    metric: p.metric,
    direction: p.direction,
    backups: p.backups,
  });
  if (p.subject) q.set('subject', p.subject);
  if (p.pod) q.set('pod', p.pod);
  return q.toString();
}

/**
 * The series frame. Kept fresh but not chatty: a five-minute step means a new
 * point at most every five minutes, so polling faster only re-renders the same
 * chart.
 */
export function useTrafficSeries(params: TrafficSeriesParams, enabled = true) {
  return useQuery({
    queryKey: ['traffic', 'series', params.tenantId ?? null, toQuery(params)],
    queryFn: () => apiFetch<{ data: TrafficFrame }>(`${base(params.tenantId)}/series?${toQuery(params)}`)
      .then((r) => r.data),
    enabled,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

/** Picker entries, ranked by the metric currently on screen. */
export function useTrafficSubjects(
  params: { from: Date; to: Date; scope: TrafficScope; subject?: string; metric: TrafficMetric; tenantId?: string },
  enabled = true,
) {
  const q = new URLSearchParams({
    from: params.from.toISOString(),
    to: params.to.toISOString(),
    scope: params.scope,
    metric: params.metric,
  });
  if (params.subject) q.set('subject', params.subject);
  return useQuery({
    queryKey: ['traffic', 'subjects', params.tenantId ?? null, q.toString()],
    queryFn: () => apiFetch<{ data: { subjects: TrafficSubject[] } }>(
      `${base(params.tenantId)}/subjects?${q.toString()}`,
    ).then((r) => r.data.subjects),
    enabled,
    staleTime: 60_000,
  });
}

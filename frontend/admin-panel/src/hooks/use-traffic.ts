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
    queryKey: ['traffic', 'series', toQuery(params)],
    queryFn: () => apiFetch<{ data: TrafficFrame }>(`/api/v1/admin/monitoring/traffic/series?${toQuery(params)}`)
      .then((r) => r.data),
    enabled,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

/** Picker entries, ranked by the metric currently on screen. */
export function useTrafficSubjects(
  params: { from: Date; to: Date; scope: TrafficScope; subject?: string; metric: TrafficMetric },
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
    queryKey: ['traffic', 'subjects', q.toString()],
    queryFn: () => apiFetch<{ data: { subjects: TrafficSubject[] } }>(
      `/api/v1/admin/monitoring/traffic/subjects?${q.toString()}`,
    ).then((r) => r.data.subjects),
    enabled,
    staleTime: 60_000,
  });
}

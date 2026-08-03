import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

/**
 * The platform's REAL alerting surface: rows the SLO evaluator writes to
 * alert_state when a monitoring rule (backend/src/modules/monitoring/rules.ts)
 * breaches its threshold.
 *
 * This endpoint existed and shipped, and the admin panel never called it. The
 * Monitoring page's "Active Alerts" instead re-labelled every AUDIT LOG row as
 * an alert and derived a severity from the HTTP status — so a routine 401 on
 * /api/v1/auth/refresh (an expired token, i.e. the refresh flow working) became
 * a "warning", and the alert count was simply "things that happened in 24h".
 * The card went red on a healthy system.
 */
export interface MonitoringAlert {
  readonly ruleId: string;
  readonly state: 'firing' | 'resolved' | string;
  readonly severity: 'warning' | 'critical' | string;
  readonly since: string | null;
  readonly lastValue: number | null;
  readonly lastNotifiedAt: string | null;
  readonly lastEvaluatedAt: string | null;
}

interface AlertsEnvelope {
  readonly data: readonly MonitoringAlert[];
}

export function useMonitoringAlerts() {
  return useQuery({
    queryKey: ['monitoring', 'alerts'],
    queryFn: () => apiFetch<AlertsEnvelope>('/api/v1/admin/monitoring/alerts'),
    // The evaluator runs on its own cadence; polling faster than it evaluates
    // just adds load without adding truth.
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/** Firing now — the only thing that should ever colour a card red. */
export function firingAlerts(alerts: readonly MonitoringAlert[]): readonly MonitoringAlert[] {
  return alerts.filter((a) => a.state === 'firing');
}

/** Everything that has stopped firing — history, not a problem. */
export function resolvedAlerts(alerts: readonly MonitoringAlert[]): readonly MonitoringAlert[] {
  return alerts.filter((a) => a.state !== 'firing');
}

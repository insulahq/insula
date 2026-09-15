import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

/**
 * Open, self-clearing conditions per tenant — the same threshold state the
 * notifications fire from, read back as a current fact.
 *
 * One fleet-wide fetch rather than one per row: the tenants table shows a
 * badge on every row it renders, and the backend answers with a single query
 * per source across all tenants.
 */
export interface TenantIssue {
  readonly tenantId: string;
  readonly kind: string;
  readonly severity: 'warning' | 'critical';
  readonly objectLabel: string;
  readonly detail: string;
  readonly actionPath: string;
  readonly since: string | null;
}

/**
 * NOTE the path: the tenants module is mounted at `/api/v1`, NOT `/api/v1/admin`
 * — unlike `resource-metrics`, which is. Guessing the admin prefix here returned
 * 404, `data` came back undefined, `issuesMap[tenant.id]` was undefined for
 * every row, and the chips simply never rendered. A silently empty map looks
 * exactly like a healthy fleet, which is the failure mode this whole feature
 * exists to remove. Caught by the integration suite against DEV.
 */
export function useTenantIssues() {
  return useQuery({
    queryKey: ['tenant-issues'],
    queryFn: () => apiFetch<{ data: Record<string, TenantIssue[]> }>('/api/v1/tenants/issues'),
    staleTime: 60_000,
  });
}

export interface IssueSummary {
  readonly count: number;
  readonly severity: 'warning' | 'critical' | null;
}

/**
 * Collapse a tenant's issues into what the badge shows.
 *
 * One critical drives the whole badge. The badge exists to say "look here",
 * and averaging severity buries exactly the thing worth looking at.
 */
export function summariseIssues(issues: readonly TenantIssue[] | undefined): IssueSummary {
  if (!issues || issues.length === 0) return { count: 0, severity: null };
  return {
    count: issues.length,
    severity: issues.some((i) => i.severity === 'critical') ? 'critical' : 'warning',
  };
}

import type { TenantResponse } from '@insula/api-contracts';
import type { SortAccessors } from '@/hooks/use-sortable';
import type { ResourceMetrics } from '@/hooks/use-resource-metrics';
import { isMetricValue } from '@/lib/format-metrics';

/**
 * Sort values for the admin Tenants table — each column sorts by what it
 * SHOWS, so the order matches what the operator reads:
 *
 * - CPU / Memory / Storage: the in-use figure (the left half of `used/limit`),
 *   numerically. A suspended or archived tenant shows `—` there, and so does
 *   one without a reading; both sort as "no value" (after every value).
 * - Placement: the node name on screen — where the tenant ACTUALLY runs when
 *   it is off its primary node, else its pinned node, by alias. `auto` (no pin)
 *   has no node and sorts as "no value".
 * - Tier: `HA` / `local` as shown (a missing tier renders, and sorts, as local).
 * - Plan: the plan name; Expires: the expiry instant, `never` as "no value".
 */

export type MetricResource = 'cpu' | 'memory' | 'storage';

type SortableTenant = Pick<
  TenantResponse,
  'id' | 'status' | 'nodeName' | 'placement' | 'storageTier' | 'planName' | 'subscriptionExpiresAt'
>;

/** Statuses whose metric cells render `—` regardless of any reading. */
const METRICS_HIDDEN_STATUSES: ReadonlySet<string> = new Set(['suspended', 'archived']);

/** The in-use number a metrics cell shows, or null when it shows a dash. */
export function metricSortValue(
  metrics: ResourceMetrics | null | undefined,
  resource: MetricResource,
  tenantStatus: string | undefined,
): number | null {
  if (tenantStatus && METRICS_HIDDEN_STATUSES.has(tenantStatus)) return null;
  if (!metrics) return null;
  const reading = metrics[resource] as { inUse?: number | null; available?: number | null } | undefined;
  const inUse = reading?.inUse ?? null;
  const available = reading?.available ?? null;
  // Mirrors the cell: without both halves it renders the unavailable marker.
  if (!isMetricValue(inUse) || !isMetricValue(available)) return null;
  return inUse;
}

/** The node name the Placement cell shows, or null for `auto`. */
export function placementSortValue(
  tenant: Pick<SortableTenant, 'nodeName' | 'placement'>,
  nodeLabel: (name: string) => string,
): string | null {
  const placement = tenant.placement;
  if (placement?.status === 'misplaced') {
    return placement.actualNodes.length > 0
      ? placement.actualNodes.map((n) => nodeLabel(n)).join(', ')
      : 'unknown';
  }
  return tenant.nodeName ? nodeLabel(tenant.nodeName) : null;
}

/** An ISO instant as epoch millis, or null when unset or unparseable. */
export function instantSortValue(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function tenantSortAccessors<T extends SortableTenant>(
  metricsById: Readonly<Record<string, ResourceMetrics | null | undefined>>,
  nodeLabel: (name: string) => string,
): SortAccessors<T> {
  const metric = (resource: MetricResource) => (t: T) => metricSortValue(metricsById[t.id], resource, t.status);
  return {
    cpu: metric('cpu'),
    memory: metric('memory'),
    storage: metric('storage'),
    placement: (t) => placementSortValue(t, nodeLabel),
    // The Tier cell renders a missing tier as `local`, so it sorts as one.
    storageTier: (t) => t.storageTier ?? 'local',
    planName: (t) => t.planName ?? null,
    subscriptionExpiresAt: (t) => instantSortValue(t.subscriptionExpiresAt),
  };
}

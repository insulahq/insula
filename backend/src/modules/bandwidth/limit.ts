/**
 * Effective monthly bandwidth-limit resolution (GB).
 *
 * Mirrors the cpu/memory/storage precedent: per-tenant override wins, else the
 * plan's `bandwidth_gb_limit`, else the platform default (100 GB/month). This is
 * the single source of truth used by the bandwidth meter (usage vs limit) and
 * the cap enforcer.
 */

import { eq } from 'drizzle-orm';
import { tenants, hostingPlans } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

export const DEFAULT_BANDWIDTH_GB_LIMIT = 100;

/** Pure: override ?? plan ?? 100 (positive values only). */
export function resolveBandwidthLimit(
  override: number | null | undefined,
  planLimit: number | null | undefined,
): number {
  if (override != null && override > 0) return override;
  if (planLimit != null && planLimit > 0) return planLimit;
  return DEFAULT_BANDWIDTH_GB_LIMIT;
}

/** Effective monthly bandwidth limit (GB) for one tenant. */
export async function getEffectiveBandwidthLimit(db: Database, tenantId: string): Promise<number> {
  const [row] = await db
    .select({
      override: tenants.bandwidthLimitOverride,
      planLimit: hostingPlans.bandwidthGbLimit,
    })
    .from(tenants)
    .leftJoin(hostingPlans, eq(tenants.planId, hostingPlans.id))
    .where(eq(tenants.id, tenantId));
  return resolveBandwidthLimit(row?.override, row?.planLimit);
}

/**
 * Tenant-facing monthly-bandwidth usage (tenant-panel Resource Usage card).
 *
 * Surfaces month-to-date egress vs the effective limit + cap state so a tenant
 * can see their bandwidth standing (they already receive the 80/90/100% alerts
 * but had no self-serve view). Same effective-limit resolution as the meter and
 * cap enforcer (override ?? plan ?? 100).
 */

import { eq } from 'drizzle-orm';
import { tenants, hostingPlans } from '../../db/schema.js';
import { resolveBandwidthLimit } from './limit.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';

export interface TenantBandwidthUsage {
  readonly usedGb: number;
  readonly limitGb: number;
  /** Month-to-date usage as a percentage of the limit (0–100+, 1 dp). */
  readonly usedPct: number;
  readonly capped: boolean;
  /** Start of the current UTC billing month (ISO), or null before the first meter tick. */
  readonly cycleStart: string | null;
  readonly source: 'override' | 'plan' | 'default';
}

/** Pure: raw tenant/plan bandwidth fields → the tenant-facing usage summary. */
export function summarizeBandwidth(input: {
  readonly usedGb: number;
  readonly override: number | null;
  readonly planLimit: number | null;
  readonly capped: boolean;
  readonly cycleStart: Date | string | null;
}): TenantBandwidthUsage {
  const limitGb = resolveBandwidthLimit(input.override, input.planLimit);
  const source: TenantBandwidthUsage['source'] =
    input.override != null && input.override > 0 ? 'override'
      : input.planLimit != null && input.planLimit > 0 ? 'plan'
        : 'default';
  const usedPct = limitGb > 0 ? Math.round((input.usedGb / limitGb) * 1000) / 10 : 0;
  return {
    usedGb: Math.round(input.usedGb * 1000) / 1000,
    limitGb,
    usedPct,
    capped: input.capped,
    cycleStart: input.cycleStart ? new Date(input.cycleStart).toISOString() : null,
    source,
  };
}

/** Read one tenant's month-to-date bandwidth usage. */
export async function getBandwidthUsage(db: Database, tenantId: string): Promise<TenantBandwidthUsage> {
  const [row] = await db
    .select({
      used: tenants.bandwidthGbUsed,
      override: tenants.bandwidthLimitOverride,
      capped: tenants.bandwidthCapped,
      cycleStart: tenants.bandwidthCycleStart,
      planLimit: hostingPlans.bandwidthGbLimit,
    })
    .from(tenants)
    .leftJoin(hostingPlans, eq(tenants.planId, hostingPlans.id))
    .where(eq(tenants.id, tenantId));
  if (!row) throw new ApiError('TENANT_NOT_FOUND', `Tenant ${tenantId} not found`, 404);
  return summarizeBandwidth({
    usedGb: Number(row.used ?? 0),
    override: row.override ?? null,
    planLimit: row.planLimit ?? null,
    capped: Boolean(row.capped),
    cycleStart: row.cycleStart ?? null,
  });
}

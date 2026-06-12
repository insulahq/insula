/**
 * Effective outbound send-limit resolution (R6 PR 1).
 *
 * Limits are plan-based: every tenant resolves, per window,
 *
 *   1. tenants.email_send_rate_limit / email_send_rate_limit_daily
 *      (per-customer override; 0 = blocked, null = inherit)
 *   2. hosting_plans.email_hourly_send_limit / email_daily_send_limit
 *      (NOT NULL, so this always resolves for a valid plan row)
 *   3. FALLBACK_* constants (only when the plan row is missing —
 *      defensive, planId is NOT NULL but plans are soft-deletable)
 *
 * Suspension forces both windows to 0:
 *   - tenants.status === 'suspended'        (lifecycle suspension)
 *   - tenants.email_outbound_suspended      (admin outbound-mail lever,
 *     narrower: receiving + webmail keep working)
 *
 * The old platform_settings key `email_send_rate_limit_default` is
 * retired — plans are the platform-wide default now.
 *
 * This module is the single source of these numbers: the Stalwart
 * throttle reconciler (stalwart-throttles.ts) and the inspection
 * endpoints both call it, so what admins see is what is enforced.
 *
 * Behavior change vs the pre-R6 resolver: an override of 0 now means
 * "blocked" (as the API contract always documented) instead of being
 * ignored.
 */

import { eq } from 'drizzle-orm';
import { tenants, hostingPlans } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type { EffectiveSendLimits, SendLimitSource } from '@insula/api-contracts';

export const FALLBACK_HOURLY_LIMIT = 50;
export const FALLBACK_DAILY_LIMIT = 100;

export type { EffectiveSendLimits, SendLimitSource };

export interface SendLimitRow {
  readonly status: string;
  readonly planId: string | null;
  readonly emailSendRateLimit: number | null;
  readonly emailSendRateLimitDaily: number | null;
  readonly emailOutboundSuspended: boolean;
  readonly planCode: string | null;
  readonly planHourly: number | null;
  readonly planDaily: number | null;
}

function resolveWindow(
  override: number | null,
  planValue: number | null,
  fallback: number,
): { limit: number; source: SendLimitSource } {
  if (typeof override === 'number' && override >= 0) {
    return { limit: override, source: 'tenant_override' };
  }
  if (typeof planValue === 'number' && planValue >= 0) {
    return { limit: planValue, source: 'plan' };
  }
  return { limit: fallback, source: 'fallback_default' };
}

/** Map the new source values onto the legacy enum kept for old consumers. */
function legacySource(
  source: SendLimitSource,
): EffectiveSendLimits['source'] {
  switch (source) {
    case 'tenant_override':
      return 'tenant_override';
    case 'suspended':
    case 'outbound_suspended':
      return 'suspended';
    case 'plan':
      return 'platform_default';
    case 'fallback_default':
      return 'hardcoded_default';
  }
}

export async function getEffectiveSendLimits(
  db: Database,
  tenantId: string,
): Promise<EffectiveSendLimits> {
  const [row] = (await db
    .select({
      status: tenants.status,
      planId: tenants.planId,
      emailSendRateLimit: tenants.emailSendRateLimit,
      emailSendRateLimitDaily: tenants.emailSendRateLimitDaily,
      emailOutboundSuspended: tenants.emailOutboundSuspended,
      planCode: hostingPlans.code,
      planHourly: hostingPlans.emailHourlySendLimit,
      planDaily: hostingPlans.emailDailySendLimit,
    })
    .from(tenants)
    .leftJoin(hostingPlans, eq(tenants.planId, hostingPlans.id))
    .where(eq(tenants.id, tenantId))) as SendLimitRow[];

  if (!row) {
    throw new ApiError('TENANT_NOT_FOUND', `Tenant '${tenantId}' not found`, 404);
  }

  return buildEffectiveSendLimits(row);
}

/**
 * Pure resolution from a pre-fetched row — exported so the throttle
 * reconciler can resolve many tenants from one bulk query without
 * N+1 lookups.
 */
export function buildEffectiveSendLimits(row: SendLimitRow): EffectiveSendLimits {
  const suspended = row.status === 'suspended';
  const outboundSuspended = row.emailOutboundSuspended === true;

  if (suspended || outboundSuspended) {
    const source: SendLimitSource = suspended ? 'suspended' : 'outbound_suspended';
    return {
      hourly: { limit: 0, source },
      daily: { limit: 0, source },
      suspended,
      outboundSuspended,
      planId: row.planId,
      planCode: row.planCode,
      limitPerHour: 0,
      source: 'suspended',
    };
  }

  const hourly = resolveWindow(
    row.emailSendRateLimit,
    row.planHourly,
    FALLBACK_HOURLY_LIMIT,
  );
  const daily = resolveWindow(
    row.emailSendRateLimitDaily,
    row.planDaily,
    FALLBACK_DAILY_LIMIT,
  );

  return {
    hourly,
    daily,
    suspended: false,
    outboundSuspended: false,
    planId: row.planId,
    planCode: row.planCode,
    limitPerHour: hourly.limit,
    source: legacySource(hourly.source),
  };
}

/**
 * Legacy name (pre-R6) — kept so existing callers keep compiling;
 * delegates to the plan-based resolver.
 */
export async function getEffectiveRateLimit(
  db: Database,
  tenantId: string,
): Promise<EffectiveSendLimits> {
  return getEffectiveSendLimits(db, tenantId);
}

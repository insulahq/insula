/**
 * Tenant mail usage (R6 PR 2) — the current UTC hour and day against the
 * effective limits, so the UI renders "used X of Y".
 *
 * The limits are per mail domain, so `hour.used` / `day.used` are the BUSIEST
 * domain's counts and `domains` lists them all (domain-usage.ts). The windows
 * are the ones Stalwart enforces: whole UTC hours and days, fixed rather than
 * rolling — a limit reached at 14:09 holds mail until 00:00 UTC.
 */
import { getEffectiveSendLimits } from '../email-outbound/rate-limit.js';
import { getTenantMailToday } from './domain-usage.js';
import type { Database } from '../../db/index.js';
import type { MailUsageResponse } from '@insula/api-contracts';

export async function getTenantMailUsage(
  db: Database,
  tenantId: string,
  now: Date = new Date(),
): Promise<MailUsageResponse> {
  const [limits, today] = await Promise.all([
    getEffectiveSendLimits(db, tenantId),
    getTenantMailToday(db, tenantId, now),
  ]);
  const hour = today.busiestHour;
  const day = today.busiestDay;

  return {
    hour: {
      used: hour?.sentThisHour ?? 0,
      limit: limits.hourly.limit,
      domain: hour?.domain ?? null,
    },
    day: {
      used: day?.sentToday ?? 0,
      limit: limits.daily.limit,
      domain: day?.domain ?? null,
      recipients: day?.recipientsToday ?? 0,
      rateLimited: day?.heldToday ?? 0,
      quotaRejected: day?.refusedToday ?? 0,
    },
    domains: [...today.domains],
    throttles: [...today.throttles],
    suspended: limits.suspended,
    outboundSuspended: limits.outboundSuspended,
  };
}

/**
 * Tenant mail usage (R6 PR 2) — current-hour and current-day sums
 * over email_send_counters, paired with the effective limits so the
 * UI renders "used X of Y".
 *
 * Windows are bucket-aligned (since :00 / since 00:00 UTC), which is
 * what the hourly counters can answer; Stalwart's own enforcement
 * uses true rolling windows, so the display is labelled "this hour" /
 * "today" rather than "last 60 minutes".
 */

import { sql, eq, and, gte } from 'drizzle-orm';
import { emailSendCounters } from '../../db/schema.js';
import { getEffectiveSendLimits } from '../email-outbound/rate-limit.js';
import type { Database } from '../../db/index.js';
import type { MailUsageResponse } from '@insula/api-contracts';

export async function getTenantMailUsage(
  db: Database,
  tenantId: string,
): Promise<MailUsageResponse> {
  const limits = await getEffectiveSendLimits(db, tenantId);

  const [row] = await db
    .select({
      hourSent: sql<number>`COALESCE(SUM(${emailSendCounters.sentCount}) FILTER (WHERE ${emailSendCounters.bucketStart} >= date_trunc('hour', NOW())), 0)`,
      daySent: sql<number>`COALESCE(SUM(${emailSendCounters.sentCount}) FILTER (WHERE ${emailSendCounters.bucketStart} >= date_trunc('day', NOW())), 0)`,
      dayRecipients: sql<number>`COALESCE(SUM(${emailSendCounters.recipientCount}) FILTER (WHERE ${emailSendCounters.bucketStart} >= date_trunc('day', NOW())), 0)`,
      dayRateLimited: sql<number>`COALESCE(SUM(${emailSendCounters.rateLimitedCount}) FILTER (WHERE ${emailSendCounters.bucketStart} >= date_trunc('day', NOW())), 0)`,
      dayQuotaRejected: sql<number>`COALESCE(SUM(${emailSendCounters.quotaRejectedCount}) FILTER (WHERE ${emailSendCounters.bucketStart} >= date_trunc('day', NOW())), 0)`,
    })
    .from(emailSendCounters)
    .where(and(
      eq(emailSendCounters.tenantId, tenantId),
      // Day filter doubles as the index range; the FILTER clauses
      // narrow further for the hour window.
      gte(emailSendCounters.bucketStart, sql`date_trunc('day', NOW())`),
    ));

  return {
    hour: {
      used: Number(row?.hourSent ?? 0),
      limit: limits.hourly.limit,
    },
    day: {
      used: Number(row?.daySent ?? 0),
      limit: limits.daily.limit,
      recipients: Number(row?.dayRecipients ?? 0),
      rateLimited: Number(row?.dayRateLimited ?? 0),
      quotaRejected: Number(row?.dayQuotaRejected ?? 0),
    },
    suspended: limits.suspended,
    outboundSuspended: limits.outboundSuspended,
  };
}

/**
 * One tenant's outbound mail per UTC calendar day — the charts on the admin
 * tenant page's Email tab and the tenant panel's Email → Statistics tab.
 *
 * Summed over email_send_counters (hourly buckets), for one domain or all of
 * them. Days are UTC so they line up with the daily send limit, which resets
 * at 00:00 UTC. The limit is per domain, so it is a line to read ONE domain
 * against; the all-domains total is not held to it.
 */
import { sql, eq, and, gte } from 'drizzle-orm';
import { emailSendCounters } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { MailDailyResponse } from '@insula/api-contracts';
import { getEffectiveSendLimits } from '../email-outbound/rate-limit.js';

export const MAIL_DAILY_DAYS = 14;

type Day = MailDailyResponse['days'][number];

/** `YYYY-MM-DD` of a UTC instant. */
function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Every day of the window, oldest first, today last. A day with no row is a
 * row of zeros: the chart must show "sent nothing", not skip the day.
 */
export function fillDays(rows: readonly Day[], days: number, now: Date): Day[] {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: Day[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = utcDate(new Date(today - i * 86_400_000));
    out.push(byDate.get(date) ?? { date, sent: 0, recipients: 0, rateLimited: 0, quotaRejected: 0 });
  }
  return out;
}

export async function getTenantMailDaily(
  db: Database,
  tenantId: string,
  opts: { readonly domain?: string | null; readonly days?: number; readonly now?: Date } = {},
): Promise<MailDailyResponse> {
  const days = opts.days ?? MAIL_DAILY_DAYS;
  const now = opts.now ?? new Date();
  const domain = opts.domain?.toLowerCase() ?? null;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (days - 1) * 86_400_000);
  const day = sql<string>`to_char(${emailSendCounters.bucketStart} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      date: day,
      sent: sql<number>`COALESCE(SUM(${emailSendCounters.sentCount}), 0)`,
      recipients: sql<number>`COALESCE(SUM(${emailSendCounters.recipientCount}), 0)`,
      rateLimited: sql<number>`COALESCE(SUM(${emailSendCounters.rateLimitedCount}), 0)`,
      quotaRejected: sql<number>`COALESCE(SUM(${emailSendCounters.quotaRejectedCount}), 0)`,
    })
    .from(emailSendCounters)
    .where(and(
      eq(emailSendCounters.tenantId, tenantId),
      gte(emailSendCounters.bucketStart, start),
      domain ? sql`LOWER(${emailSendCounters.domain}) = ${domain}` : undefined,
    ))
    .groupBy(day);
  const limits = await getEffectiveSendLimits(db, tenantId);

  return {
    domain,
    dailyLimit: limits.daily.limit,
    days: fillDays(rows.map((r) => ({
      date: String(r.date),
      // SUM over int comes back as a string from pg (bigint).
      sent: Number(r.sent),
      recipients: Number(r.recipients),
      rateLimited: Number(r.rateLimited),
      quotaRejected: Number(r.quotaRejected),
    })), days, now),
  };
}

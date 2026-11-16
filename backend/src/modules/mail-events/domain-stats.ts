/**
 * One tenant's outbound mail, per domain — the tenant panel's Email →
 * Statistics tab, and the admin tenant page's Email tab.
 *
 * The same counters and windows as the operator's Monitoring → Mail table
 * (rolling 24 hours and 7 days over email_send_counters), narrowed to one
 * tenant, so the figures a tenant reads and the ones their operator reads
 * agree. Beside them, each domain's current UTC hour and day — the windows the
 * per-domain limits count in — and the limit holding it back, if one is.
 *
 * Every email domain of the tenant is listed, including the ones that sent
 * nothing: a domain missing from the table reads as "not mine" or "broken",
 * where zero says what is true. A domain that sent mail without an email
 * domain row (it sends through the relay but hosts no mailboxes) is listed
 * too, marked as such.
 */
import { sql, eq, and, gte } from 'drizzle-orm';
import { emailSendCounters, emailDomains, domains } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { MailDomainStatsResponse } from '@insula/api-contracts';
import { getEffectiveSendLimits } from '../email-outbound/rate-limit.js';
import { readDomainUsage, throttleOf } from './domain-usage.js';

export const DOMAIN_STATS_WINDOW_DAYS = 7;

type DomainRow = MailDomainStatsResponse['domains'][number];
type Counts = Omit<DomainRow, 'domain' | 'emailHosted' | 'throttle'>;

const ZERO: Counts = {
  sent24h: 0, sent7d: 0, recipients7d: 0, rateLimited7d: 0, quotaRejected7d: 0, sentThisHour: 0, sentToday: 0,
};

export async function getTenantMailDomainStats(
  db: Database,
  tenantId: string,
  now: Date = new Date(),
): Promise<MailDomainStatsResponse> {
  const [counted, hosted, today, limits] = await Promise.all([
    db
      .select({
        domain: emailSendCounters.domain,
        sent24h: sql<number>`COALESCE(SUM(${emailSendCounters.sentCount}) FILTER (WHERE ${emailSendCounters.bucketStart} >= NOW() - INTERVAL '24 hours'), 0)`,
        sent7d: sql<number>`COALESCE(SUM(${emailSendCounters.sentCount}), 0)`,
        recipients7d: sql<number>`COALESCE(SUM(${emailSendCounters.recipientCount}), 0)`,
        rateLimited7d: sql<number>`COALESCE(SUM(${emailSendCounters.rateLimitedCount}), 0)`,
        quotaRejected7d: sql<number>`COALESCE(SUM(${emailSendCounters.quotaRejectedCount}), 0)`,
      })
      .from(emailSendCounters)
      .where(and(
        eq(emailSendCounters.tenantId, tenantId),
        gte(emailSendCounters.bucketStart, sql`NOW() - make_interval(days => ${DOMAIN_STATS_WINDOW_DAYS})`),
      ))
      .groupBy(emailSendCounters.domain),
    db
      .select({ id: emailDomains.id, domain: domains.domainName })
      .from(emailDomains)
      .innerJoin(domains, eq(domains.id, emailDomains.domainId))
      .where(eq(emailDomains.tenantId, tenantId)),
    readDomainUsage(db, { tenantId, now }),
    getEffectiveSendLimits(db, tenantId),
  ]);

  // Domain names compare case-insensitively: the counters store the envelope
  // sender's spelling, the domains table the tenant's — and two spellings of
  // one domain are two counter rows, added together here.
  const byDomain = new Map<string, Omit<DomainRow, 'throttle'>>();
  const ids = new Map<string, string>();
  for (const h of hosted) {
    byDomain.set(h.domain.toLowerCase(), { domain: h.domain, emailHosted: true, ...ZERO });
    ids.set(h.domain.toLowerCase(), h.id);
  }
  for (const c of counted) {
    const key = c.domain.toLowerCase();
    const known = byDomain.get(key) ?? { domain: c.domain, emailHosted: false, ...ZERO };
    byDomain.set(key, {
      ...known,
      sent24h: known.sent24h + Number(c.sent24h),
      sent7d: known.sent7d + Number(c.sent7d),
      recipients7d: known.recipients7d + Number(c.recipients7d),
      rateLimited7d: known.rateLimited7d + Number(c.rateLimited7d),
      quotaRejected7d: known.quotaRejected7d + Number(c.quotaRejected7d),
    });
  }
  // readDomainUsage already groups by lower(domain).
  const todayBy = new Map(today.map((u) => [u.domain, u]));

  return {
    windowDays: DOMAIN_STATS_WINDOW_DAYS,
    hourlyLimit: limits.hourly.limit,
    dailyLimit: limits.daily.limit,
    outboundSuspended: limits.suspended || limits.outboundSuspended,
    domains: [...byDomain.entries()]
      .map(([key, d]): DomainRow => {
        const u = todayBy.get(key);
        return {
          ...d,
          sentThisHour: u?.sentThisHour ?? 0,
          sentToday: u?.sentToday ?? 0,
          throttle: u ? throttleOf({ ...u, domain: d.domain }, ids.get(key) ?? null, now) : null,
        };
      })
      .sort((a, b) => b.sent7d - a.sent7d || a.domain.localeCompare(b.domain)),
  };
}

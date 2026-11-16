/**
 * Per-domain sending in the current UTC hour and day, and the limits holding
 * any of it back.
 *
 * The sending limits are PER MAIL DOMAIN: Stalwart keys every throttle by
 * sender domain (email-outbound/stalwart-throttles.ts), so a tenant with two
 * domains may send the daily limit from each. Everything that compares a count
 * with a limit — the admin tiles, the tenant dashboard, the 80%/100% alerts —
 * reads one domain's count from here. Summing the tenant's domains against the
 * per-domain limit reported a tenant "over its limit" while nothing was held.
 *
 * Stalwart's windows are fixed and epoch-aligned (store/dispatch/lookup.rs:
 * `now / period`), so an hourly window is a whole UTC hour and the daily one a
 * UTC day. A held message is retried when its window resets — the next full
 * hour, or 00:00 UTC. Which window held it is recorded at ingest
 * (rate_limited_daily_count), which is what lets "held now" be told apart from
 * "held earlier and already released".
 *
 * Counts here are the platform's, from the webhook: messages accepted. Stalwart
 * counts delivery ATTEMPTS against its windows, retries included, so it can
 * start holding mail while `sentToday` is still under the limit. The UI says so.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import type { MailDomainUsage, MailThrottle } from '@insula/api-contracts';
import { emailSendCounters, emailDomains, domains } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** One domain's counters for the current hour and day. */
export interface DomainUsageCounts {
  readonly domain: string;
  readonly sentThisHour: number;
  readonly sentToday: number;
  readonly recipientsToday: number;
  /** Holds this hour by an hourly window — released at the next full hour. */
  readonly heldThisHourHourly: number;
  /** Holds today by the daily window — released at 00:00 UTC. */
  readonly heldTodayDaily: number;
  readonly heldToday: number;
  readonly refusedThisHour: number;
  readonly refusedToday: number;
}

export interface TenantDomainUsage extends DomainUsageCounts {
  readonly tenantId: string;
}

/** Start of the current UTC hour and day. */
export function windowStarts(now: Date): { hourStart: Date; dayStart: Date } {
  const ms = now.getTime();
  return {
    hourStart: new Date(Math.floor(ms / HOUR_MS) * HOUR_MS),
    dayStart: new Date(Math.floor(ms / DAY_MS) * DAY_MS),
  };
}

/**
 * Every (tenant, domain) that has counters today.
 *
 * The window edges are computed here and passed in, not taken from the
 * database's `date_trunc(.., NOW())`: that follows the session time zone, and
 * Stalwart's windows are UTC whatever the server's zone is.
 */
export async function readDomainUsage(
  db: Database,
  opts: { readonly tenantId?: string; readonly now?: Date } = {},
): Promise<TenantDomainUsage[]> {
  const { hourStart, dayStart } = windowStarts(opts.now ?? new Date());
  const c = emailSendCounters;
  const inHour = sql`${c.bucketStart} >= ${hourStart.toISOString()}::timestamptz`;
  const domainKey = sql<string>`LOWER(${c.domain})`;
  const rows = await db
    .select({
      tenantId: c.tenantId,
      domain: domainKey,
      sentThisHour: sql<number>`COALESCE(SUM(${c.sentCount}) FILTER (WHERE ${inHour}), 0)`,
      sentToday: sql<number>`COALESCE(SUM(${c.sentCount}), 0)`,
      recipientsToday: sql<number>`COALESCE(SUM(${c.recipientCount}), 0)`,
      heldThisHourHourly: sql<number>`COALESCE(SUM(${c.rateLimitedCount} - ${c.rateLimitedDailyCount}) FILTER (WHERE ${inHour}), 0)`,
      heldTodayDaily: sql<number>`COALESCE(SUM(${c.rateLimitedDailyCount}), 0)`,
      heldToday: sql<number>`COALESCE(SUM(${c.rateLimitedCount}), 0)`,
      refusedThisHour: sql<number>`COALESCE(SUM(${c.quotaRejectedCount}) FILTER (WHERE ${inHour}), 0)`,
      refusedToday: sql<number>`COALESCE(SUM(${c.quotaRejectedCount}), 0)`,
    })
    .from(c)
    .where(and(
      gte(c.bucketStart, dayStart),
      opts.tenantId ? eq(c.tenantId, opts.tenantId) : undefined,
    ))
    .groupBy(c.tenantId, domainKey);

  // SUM over integer is a bigint, which pg returns as a string.
  return rows.map((r) => ({
    tenantId: r.tenantId,
    domain: String(r.domain),
    sentThisHour: Number(r.sentThisHour),
    sentToday: Number(r.sentToday),
    recipientsToday: Number(r.recipientsToday),
    heldThisHourHourly: Math.max(0, Number(r.heldThisHourHourly)),
    heldTodayDaily: Number(r.heldTodayDaily),
    heldToday: Number(r.heldToday),
    refusedThisHour: Number(r.refusedThisHour),
    refusedToday: Number(r.refusedToday),
  }));
}

/** lower(domain name) → email_domains.id, for the tenant's mail-hosting domains. */
export async function emailDomainIds(db: Database, tenantId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: emailDomains.id, domain: domains.domainName })
    .from(emailDomains)
    .innerJoin(domains, eq(domains.id, emailDomains.domainId))
    .where(eq(emailDomains.tenantId, tenantId));
  return new Map(rows.map((r) => [r.domain.toLowerCase(), r.id]));
}

/**
 * Pure: is a limit holding back or refusing this domain's mail right now?
 *
 * Held now = the daily window's holds today (they wait until 00:00 UTC) plus
 * the hourly window's holds this hour (they wait until the next full hour).
 * An hourly hold from an earlier hour was retried when its hour ended, so it
 * is not waiting any more — and if the retry was held again, that is a new
 * hold in the current hour.
 *
 * Refusing = the domain's queue cap turned a submission away this hour. A
 * refusal is only seen when something is submitted, so an earlier one says
 * nothing about now; `refusedToday` still reports it.
 */
export function throttleOf(
  u: DomainUsageCounts,
  emailDomainId: string | null,
  now: Date,
): MailThrottle | null {
  const heldNow = u.heldTodayDaily + u.heldThisHourHourly;
  const refusing = u.refusedThisHour > 0;
  if (heldNow === 0 && !refusing) return null;

  const window = u.heldTodayDaily > 0 ? 'day' : u.heldThisHourHourly > 0 ? 'hour' : null;
  const period = window === 'day' ? DAY_MS : HOUR_MS;
  const releasesAt = window
    ? new Date((Math.floor(now.getTime() / period) + 1) * period).toISOString()
    : null;

  return {
    domain: u.domain,
    emailDomainId,
    window,
    heldNow,
    releasesAt,
    heldToday: u.heldToday,
    refusedToday: u.refusedToday,
    refusing,
    sentThisHour: u.sentThisHour,
    sentToday: u.sentToday,
  };
}

export interface TenantMailToday {
  /** Busiest first. */
  readonly domains: readonly MailDomainUsage[];
  readonly throttles: readonly MailThrottle[];
  /** The domain with the most mail this hour / today, or null when none sent. */
  readonly busiestHour: DomainUsageCounts | null;
  readonly busiestDay: DomainUsageCounts | null;
}

/** Pure: one tenant's rows → the per-domain view every surface reads. */
export function summariseTenantToday(
  rows: readonly DomainUsageCounts[],
  ids: ReadonlyMap<string, string>,
  now: Date,
): TenantMailToday {
  const byDay = [...rows].sort((a, b) => b.sentToday - a.sentToday || a.domain.localeCompare(b.domain));
  const byHour = [...rows].sort((a, b) => b.sentThisHour - a.sentThisHour || a.domain.localeCompare(b.domain));
  const idOf = (d: string): string | null => ids.get(d.toLowerCase()) ?? null;
  return {
    domains: byDay.map((u) => ({
      domain: u.domain,
      emailDomainId: idOf(u.domain),
      sentThisHour: u.sentThisHour,
      sentToday: u.sentToday,
      recipientsToday: u.recipientsToday,
      heldToday: u.heldToday,
      refusedToday: u.refusedToday,
    })),
    throttles: byDay
      .map((u) => throttleOf(u, idOf(u.domain), now))
      .filter((t): t is MailThrottle => t !== null),
    busiestHour: byHour[0] && byHour[0].sentThisHour > 0 ? byHour[0] : null,
    busiestDay: byDay[0] && byDay[0].sentToday > 0 ? byDay[0] : null,
  };
}

/** One tenant's sending today, per domain. */
export async function getTenantMailToday(
  db: Database,
  tenantId: string,
  now: Date = new Date(),
): Promise<TenantMailToday> {
  const [rows, ids] = await Promise.all([
    readDomainUsage(db, { tenantId, now }),
    emailDomainIds(db, tenantId),
  ]);
  return summariseTenantToday(rows, ids, now);
}

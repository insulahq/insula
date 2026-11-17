/**
 * Why the WAF let a request through that matched rules — waf_logs.pass_reason.
 *
 * ModSecurity's JSON audit record says whether it refused the request
 * (`"is_interrupted":true|false`; measured on production, CRS 4.30: a blocked
 * request is interrupted with 403, a request from an allowlisted address is
 * not, answers 200 and still lists 949110 "Inbound Anomaly Score Exceeded").
 * When it did not refuse, the reason is whichever list covers the source now:
 * the platform allowlist (rendered as a DetectionOnly bypass on every site),
 * else the route's WAF trusted IPs, else none — then the score stayed below
 * the threshold, or (949110 present) the verdict was not enforced for a reason
 * no list explains any more.
 *
 * The verdict decides "blocked or not"; the lists only name the reason. So a
 * list that changed between the request and the scrape can mislabel WHY a
 * request passed, never claim that a blocked request passed.
 */
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { WafPassReason } from '@insula/api-contracts';
import { platformSettings, wafLogs } from '../../db/schema.js';
import { listAllowlistEntries } from '../security-hardening/crowdsec-allowlists.js';
import { addressMatcher } from '../waf-trusted-ips/ip-value.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = NodePgDatabase<any>;

export interface PassFacts {
  /** The audit record's is_interrupted; undefined when the record was not read this cycle. */
  readonly interrupted?: boolean;
  /** 949110 is in the record's messages: the score reached the threshold. */
  readonly scoreExceeded?: boolean;
  readonly sourceIp: string;
}

export interface PassLists {
  /** Matches the platform allowlist; null when it could not be read. */
  readonly allowlisted: ((ip: string) => boolean) | null;
  /** Matches the event's route's trusted IPs; null when the route has none. */
  readonly trusted: ((ip: string) => boolean) | null;
}

/** Null when the request was refused, or the record that says so was not read. */
export function resolvePassReason(facts: PassFacts, lists: PassLists): WafPassReason | null {
  if (facts.interrupted !== false) return null;
  const ip = facts.sourceIp;
  if (ip && ip !== '0.0.0.0') {
    if (lists.allowlisted?.(ip)) return 'allowlisted_ip';
    if (lists.trusted?.(ip)) return 'trusted_ip';
  }
  return facts.scoreExceeded ? 'not_enforced' : 'below_threshold';
}

const ALLOWLIST_TTL_MS = 60_000;

/** One platform allowlist entry: an address or network, and when it was added (null = not known). */
export interface AllowlistEntry {
  readonly value: string;
  readonly addedAt: string | null;
}

/** The allowlist's address entries through cscli (country entries are not addresses); null when it cannot be read. */
export async function loadAllowlistEntries(): Promise<AllowlistEntry[] | null> {
  try {
    return (await listAllowlistEntries(process.env.KUBECONFIG))
      .filter((e) => e.scope !== 'Country')
      .map((e) => ({ value: e.value, addedAt: e.addedAt }));
  } catch {
    return null;
  }
}

/**
 * The platform allowlist as a matcher, read through cscli at most once a
 * minute — and only by a cycle that has a request to explain. A failed read
 * answers the last list read (it only names a reason: the audit record has
 * already said the request was let through), or null before any read
 * succeeded; the next call retries.
 */
export function createAllowlistCache(
  load: () => Promise<ReadonlyArray<string>> = async () => {
    const entries = await loadAllowlistEntries();
    if (entries === null) throw new Error('CrowdSec allowlist unavailable');
    return entries.map((e) => e.value);
  },
  now: () => number = Date.now,
): () => Promise<((ip: string) => boolean) | null> {
  let cached: { readonly at: number; readonly match: (ip: string) => boolean } | null = null;
  return async () => {
    if (cached && now() - cached.at < ALLOWLIST_TTL_MS) return cached.match;
    try {
      const match = addressMatcher(await load());
      cached = { at: now(), match };
      return match;
    } catch {
      return cached?.match ?? null;
    }
  };
}

const BACKFILL_SETTING_KEY = 'waf-logs-pass-reason-backfill';
/**
 * From an allowlist entry's creation until the WAF runs its bypass: the
 * exclusions reconcile (5 min) and the modsec pods' roll, with a margin.
 * A request in that window may still have been blocked.
 */
const BYPASS_SETTLE_MS = 15 * 60_000;

/**
 * One-off, after the upgrade that added pass_reason. Rows written before it
 * carry no reason, so a request an allowlisted workstation sent reads as
 * blocked. Marked allowlisted_ip are the rows that
 *  - come from an address on today's allowlist,
 *  - were logged after the entry covering it was added (plus BYPASS_SETTLE_MS),
 *    so the WAF already ran that address in detection-only mode — a block from
 *    before the address was allowlisted keeps its rows;
 *  - and belong to a request with no 949110 row, the [error] line ModSecurity
 *    writes only when it refuses one.
 * An entry whose creation time is unknown marks nothing. Done once (a
 * platform setting); retried next cycle when the allowlist cannot be read.
 */
export async function backfillAllowlistedPassReasons(
  db: Db,
  loadEntries: () => Promise<ReadonlyArray<AllowlistEntry> | null> = loadAllowlistEntries,
): Promise<{ readonly ran: boolean; readonly updated: number; readonly done: boolean }> {
  const [flag] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, BACKFILL_SETTING_KEY))
    .limit(1);
  if (flag) return { ran: false, updated: 0, done: true };
  const entries = await loadEntries();
  if (entries === null) return { ran: false, updated: 0, done: false };

  const dated = entries
    .map((e) => ({ match: addressMatcher([e.value]), since: e.addedAt === null ? NaN : Date.parse(e.addedAt) + BYPASS_SETTLE_MS }))
    .filter((e) => Number.isFinite(e.since));
  const candidates = dated.length === 0 ? [] : await db
    .selectDistinct({ ip: wafLogs.sourceIp })
    .from(wafLogs)
    .where(and(isNull(wafLogs.passReason), ne(wafLogs.ruleId, '949110'), sql`${wafLogs.eventKey} IS NOT NULL`));
  let updated = 0;
  for (const { ip } of candidates) {
    if (typeof ip !== 'string') continue;
    const covering = dated.filter((e) => e.match(ip));
    if (covering.length === 0) continue;
    const since = new Date(Math.min(...covering.map((e) => e.since))).toISOString();
    const res = await db
      .update(wafLogs)
      .set({ passReason: 'allowlisted_ip' })
      .where(and(
        isNull(wafLogs.passReason),
        ne(wafLogs.ruleId, '949110'),
        eq(wafLogs.sourceIp, ip),
        sql`${wafLogs.eventKey} IS NOT NULL`,
        // created_at is a UTC timestamp without a zone.
        sql`${wafLogs.createdAt} > (${since}::timestamptz AT TIME ZONE 'UTC')`,
        sql`NOT EXISTS (SELECT 1 FROM waf_logs b WHERE b.event_key = split_part(${wafLogs.eventKey}, ':', 1) || ':949110')`,
      ))
      .returning({ id: wafLogs.id });
    updated += res.length;
  }
  const value = JSON.stringify({ at: new Date().toISOString(), updated });
  await db.insert(platformSettings).values({ key: BACKFILL_SETTING_KEY, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value } });
  return { ran: true, updated, done: true };
}

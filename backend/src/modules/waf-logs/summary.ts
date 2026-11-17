/**
 * The "would block" summary: WAF events grouped by host, rule and request
 * path — what an operator decides exceptions from. A list of raw events is
 * unreadable at the scale a week of detection produces; this is the view the
 * SUNSHINE dry-run analysis had to be done by hand for.
 *
 * Rows of the scoring meta-rules (949110 "anomaly score exceeded", 980xxx) are
 * not rule groups: they say that a request was blocked, not why.
 *
 * `requests` counts distinct requests — ModSecurity's transaction id, the part
 * of event_key before the rule id — not 949110 rows. A request can be refused
 * without the anomaly score: a body the WAF cannot parse (200002, HTTP 400)
 * writes no 949110 row, and counting those undercounted (staging showed 4 of 6).
 * Rows without an event_key (a fallback the scraper rarely writes) count once each.
 */
import { and, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { WafEventsQuery, WafLogSummaryResponse } from '@insula/api-contracts';
import { wafLogs } from '../../db/schema.js';
import { buildFilters } from '../security-hardening/waf-events.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = NodePgDatabase<any>;

export const SUMMARY_MAX_ROWS = 200;

interface GroupRow {
  hostname: string;
  rule_id: string;
  message: string;
  path: string;
  requests: number;
  detection_only: number;
  not_blocked: number;
  source_ips: number;
  first_seen: Date | string;
  last_seen: Date | string;
}

interface TopIpRow {
  hostname: string;
  rule_id: string;
  path: string;
  source_ip: string;
  n: number;
}

/** A request path as the summary groups it: no query string, `/` when empty. */
export const PATH_SQL = sql.raw(`coalesce(nullif(split_part(coalesce(request_uri, '/'), '?', 1), ''), '/')`);
/** The request (ModSecurity transaction) a row belongs to. */
export const TX_SQL = sql.raw(`coalesce(nullif(split_part(event_key, ':', 1), ''), id)`);
/** The WAF let the request through: detection-only mode or a pass reason (waf-logs/pass-reason.ts). */
export const NOT_BLOCKED_SQL = sql.raw('(detection_only OR pass_reason IS NOT NULL)');

/** How many of a group's top addresses the summary names. */
const TOP_IPS_PER_GROUP = 3;

const iso = (v: Date | string): string => new Date(v).toISOString();

export async function summarizeWafLogs(db: Db, filters: SQL[]): Promise<WafLogSummaryResponse> {
  const where = and(...filters) ?? sql`TRUE`;
  const groups = await db.execute(sql`
    SELECT hostname,
           rule_id,
           max(message) AS message,
           ${PATH_SQL} AS path,
           count(*)::int AS requests,
           count(*) FILTER (WHERE detection_only)::int AS detection_only,
           count(*) FILTER (WHERE ${NOT_BLOCKED_SQL})::int AS not_blocked,
           -- 0.0.0.0 is the scraper's "not known yet", not an address.
           count(DISTINCT source_ip) FILTER (WHERE source_ip <> '0.0.0.0')::int AS source_ips,
           min(created_at) AS first_seen,
           max(created_at) AS last_seen
      FROM ${wafLogs}
     WHERE ${where} AND rule_id <> '949110' AND rule_id NOT LIKE '980%'
     GROUP BY hostname, rule_id, ${PATH_SQL}
     ORDER BY count(*) DESC, max(created_at) DESC, rule_id, 4
     LIMIT ${SUMMARY_MAX_ROWS + 1}
  `);
  const [total] = (await db.execute(sql`
    SELECT count(DISTINCT ${TX_SQL})::int AS requests,
           count(DISTINCT ${TX_SQL}) FILTER (WHERE ${NOT_BLOCKED_SQL})::int AS not_blocked
      FROM ${wafLogs} WHERE ${where}
  `) as unknown as { rows: Array<{ requests: number; not_blocked: number }> }).rows;
  // Who sent each group's requests — the addresses a tenant attributes and
  // trusts, which the IP count alone never said.
  const topIps = (await db.execute(sql`
    SELECT hostname, rule_id, path, source_ip, n FROM (
      SELECT hostname, rule_id, ${PATH_SQL} AS path, source_ip, count(*)::int AS n,
             row_number() OVER (PARTITION BY hostname, rule_id, ${PATH_SQL} ORDER BY count(*) DESC, source_ip) AS rk
        FROM ${wafLogs}
       WHERE ${where} AND rule_id <> '949110' AND rule_id NOT LIKE '980%'
         AND source_ip IS NOT NULL AND source_ip <> '0.0.0.0'
       GROUP BY hostname, rule_id, ${PATH_SQL}, source_ip
    ) ranked
     WHERE rk <= ${TOP_IPS_PER_GROUP}
     ORDER BY hostname, rule_id, path, n DESC, source_ip
  `) as unknown as { rows: TopIpRow[] }).rows;
  const topByGroup = new Map<string, Array<{ sourceIp: string; requests: number }>>();
  for (const t of topIps) {
    const key = `${t.hostname}\u0000${t.rule_id}\u0000${t.path}`;
    topByGroup.set(key, [...(topByGroup.get(key) ?? []), { sourceIp: t.source_ip, requests: Number(t.n) }]);
  }
  const rows = (groups as unknown as { rows: GroupRow[] }).rows;
  return {
    requests: Number(total?.requests ?? 0),
    notBlocked: Number(total?.not_blocked ?? 0),
    truncated: rows.length > SUMMARY_MAX_ROWS,
    rows: rows.slice(0, SUMMARY_MAX_ROWS).map((r) => ({
      hostname: r.hostname,
      ruleId: r.rule_id,
      message: r.message,
      path: r.path,
      requests: Number(r.requests),
      detectionOnly: Number(r.detection_only),
      notBlocked: Number(r.not_blocked),
      sourceIps: Number(r.source_ips),
      topSourceIps: topByGroup.get(`${r.hostname}\u0000${r.rule_id}\u0000${r.path}`) ?? [],
      firstSeenAt: iso(r.first_seen),
      lastSeenAt: iso(r.last_seen),
    })),
  };
}

/** Admin: across hosts, with the same filters as the WAF Events list. */
export function summarizeForAdmin(db: Db, query: WafEventsQuery): Promise<WafLogSummaryResponse> {
  return summarizeWafLogs(db, buildFilters(query));
}

/** Tenant: one route, the caller's ownership already checked by the route handler. */
export function summarizeForRoute(db: Db, routeId: string, sinceSeconds: number): Promise<WafLogSummaryResponse> {
  // The window from now() in SQL: a JS Date would be read in the pod's local time.
  return summarizeWafLogs(db, [
    sql`${wafLogs.routeId} = ${routeId}`,
    sql`${wafLogs.createdAt} >= now() - make_interval(secs => ${sinceSeconds})`,
  ]);
}

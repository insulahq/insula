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
  source_ips: number;
  first_seen: Date | string;
  last_seen: Date | string;
}

const iso = (v: Date | string): string => new Date(v).toISOString();

export async function summarizeWafLogs(db: Db, filters: SQL[]): Promise<WafLogSummaryResponse> {
  const where = and(...filters) ?? sql`TRUE`;
  const groups = await db.execute(sql`
    SELECT hostname,
           rule_id,
           max(message) AS message,
           coalesce(nullif(split_part(coalesce(request_uri, '/'), '?', 1), ''), '/') AS path,
           count(*)::int AS requests,
           count(*) FILTER (WHERE detection_only)::int AS detection_only,
           count(DISTINCT source_ip)::int AS source_ips,
           min(created_at) AS first_seen,
           max(created_at) AS last_seen
      FROM ${wafLogs}
     WHERE ${where} AND rule_id <> '949110' AND rule_id NOT LIKE '980%'
     GROUP BY hostname, rule_id, coalesce(nullif(split_part(coalesce(request_uri, '/'), '?', 1), ''), '/')
     ORDER BY count(*) DESC, max(created_at) DESC, rule_id, 4
     LIMIT ${SUMMARY_MAX_ROWS + 1}
  `);
  const [total] = (await db.execute(sql`
    SELECT count(DISTINCT coalesce(nullif(split_part(event_key, ':', 1), ''), id))::int AS requests
      FROM ${wafLogs} WHERE ${where}
  `) as unknown as { rows: Array<{ requests: number }> }).rows;
  const rows = (groups as unknown as { rows: GroupRow[] }).rows;
  return {
    requests: Number(total?.requests ?? 0),
    truncated: rows.length > SUMMARY_MAX_ROWS,
    rows: rows.slice(0, SUMMARY_MAX_ROWS).map((r) => ({
      hostname: r.hostname,
      ruleId: r.rule_id,
      message: r.message,
      path: r.path,
      requests: Number(r.requests),
      detectionOnly: Number(r.detection_only),
      sourceIps: Number(r.source_ips),
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

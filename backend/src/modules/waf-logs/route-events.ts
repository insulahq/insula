/**
 * A tenant route's WAF events: the event list (filtered, sorted by the
 * server, cursor-paged) and the events grouped by source address.
 *
 * The list used to be the newest 50 rows with no filter and no paging, sorted
 * in the browser: a tenant could not find one address's requests once 50
 * newer rows existed (an hour of a busy site), and a column sort ordered only
 * those 50. The summary showed an IP COUNT per rule and path, never which
 * addresses. Both callers check the route's ownership first.
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  WAF_PASS_REASONS,
  type RouteWafLogEntry,
  type RouteWafLogsQuery,
  type WafLogSourceRow,
  type WafLogSourcesResponse,
  type WafPassReason,
} from '@insula/api-contracts';
import { wafLogs } from '../../db/schema.js';
import {
  encodeListCursor,
  listCursorCondition,
  listOrderBy,
  listSortKeySelect,
  resolveListSort,
  type SortFields,
} from '../../shared/list-sort.js';
import type { PaginationMeta } from '../../shared/response.js';
import { addressMatcher } from '../waf-trusted-ips/ip-value.js';
import { trustedIpsByRoute } from '../waf-trusted-ips/service.js';
import { NOT_BLOCKED_SQL, PATH_SQL, TX_SQL } from './summary.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = NodePgDatabase<any>;

const CURSOR_RESOURCE = 'route_waf_log';

const SORT_FIELDS: SortFields = {
  createdAt: { expr: wafLogs.createdAt, kind: 'timestamp' },
  sourceIp: { expr: wafLogs.sourceIp, kind: 'text' },
  // Worst first when descending, as the panel always ordered levels.
  severity: {
    expr: sql`CASE ${wafLogs.severity} WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 WHEN 'info' THEN 1 ELSE 0 END`,
    kind: 'numeric',
  },
  ruleId: { expr: wafLogs.ruleId, kind: 'text' },
  request: { expr: wafLogs.requestUri, kind: 'text' },
};

const toEntry = (row: typeof wafLogs.$inferSelect): RouteWafLogEntry => ({
  id: row.id,
  routeId: row.routeId ?? null,
  ruleId: row.ruleId,
  severity: row.severity,
  message: row.message,
  requestUri: row.requestUri ?? null,
  requestMethod: row.requestMethod ?? null,
  sourceIp: row.sourceIp ?? null,
  createdAt: row.createdAt.toISOString(),
  detectionOnly: row.detectionOnly,
  passReason: (row.passReason ?? null) as WafPassReason | null,
});

export async function listRouteWafEvents(
  db: Db,
  routeId: string,
  query: RouteWafLogsQuery,
): Promise<{ readonly rows: RouteWafLogEntry[]; readonly pagination: PaginationMeta }> {
  const sort = resolveListSort(query.sort, SORT_FIELDS, { field: 'createdAt', direction: 'desc' });
  const filters: SQL[] = [eq(wafLogs.routeId, routeId)];
  if (query.sourceIp) filters.push(eq(wafLogs.sourceIp, query.sourceIp));
  if (query.ruleId) filters.push(eq(wafLogs.ruleId, query.ruleId));
  if (query.path) filters.push(sql`${PATH_SQL} = ${query.path}`);
  if (query.outcome === 'blocked') filters.push(sql`NOT ${NOT_BLOCKED_SQL}`);
  if (query.outcome === 'not_blocked') filters.push(NOT_BLOCKED_SQL);
  const filterWhere = and(...filters);
  const after = listCursorCondition(query.cursor, CURSOR_RESOURCE, sort, SORT_FIELDS, wafLogs.id);

  const rows = await db
    .select({ row: wafLogs, sortKey: listSortKeySelect(sort, SORT_FIELDS) })
    .from(wafLogs)
    .where(after ? and(filterWhere, after) : filterWhere)
    .orderBy(...listOrderBy(sort, SORT_FIELDS, wafLogs.id))
    .limit(query.limit + 1);
  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(wafLogs).where(filterWhere);
  return {
    rows: page.map((r) => toEntry(r.row)),
    pagination: {
      cursor: hasMore && last ? encodeListCursor(CURSOR_RESOURCE, sort, { id: last.row.id, sortKey: last.sortKey }) : null,
      has_more: hasMore,
      page_size: page.length,
      total_count: Number(count?.n ?? 0),
    },
  };
}

export const SOURCES_MAX_ROWS = 200;
const TOP_RULES_PER_SOURCE = 5;

interface SourceRow {
  source_ip: string;
  requests: number;
  not_blocked: number;
  pass_reasons: string[] | null;
  paths: number;
  first_seen: Date | string;
  last_seen: Date | string;
}

/** The route's events in the last `sinceSeconds`, one row per source address, most requests first. */
export async function summarizeRouteSources(db: Db, routeId: string, sinceSeconds: number): Promise<WafLogSourcesResponse> {
  // The window from now() in SQL: a JS Date would be read in the pod's local time.
  const where = sql`${wafLogs.routeId} = ${routeId}
    AND ${wafLogs.createdAt} >= now() - make_interval(secs => ${sinceSeconds})
    AND ${wafLogs.sourceIp} IS NOT NULL AND ${wafLogs.sourceIp} <> '0.0.0.0'`;
  const sources = (await db.execute(sql`
    SELECT source_ip,
           count(DISTINCT ${TX_SQL})::int AS requests,
           count(DISTINCT ${TX_SQL}) FILTER (WHERE ${NOT_BLOCKED_SQL})::int AS not_blocked,
           array_remove(array_agg(DISTINCT pass_reason), NULL) AS pass_reasons,
           count(DISTINCT ${PATH_SQL})::int AS paths,
           min(created_at) AS first_seen,
           max(created_at) AS last_seen
      FROM ${wafLogs}
     WHERE ${where}
     GROUP BY source_ip
     ORDER BY count(DISTINCT ${TX_SQL}) DESC, max(created_at) DESC, source_ip
     LIMIT ${SOURCES_MAX_ROWS + 1}
  `) as unknown as { rows: SourceRow[] }).rows;
  const shown = sources.slice(0, SOURCES_MAX_ROWS);
  if (shown.length === 0) return { rows: [], truncated: false };

  const topRules = (await db.execute(sql`
    SELECT source_ip, rule_id FROM (
      SELECT source_ip, rule_id,
             row_number() OVER (PARTITION BY source_ip ORDER BY count(*) DESC, rule_id) AS rk
        FROM ${wafLogs}
       WHERE ${where} AND rule_id <> '949110' AND rule_id NOT LIKE '980%'
       GROUP BY source_ip, rule_id
    ) ranked
     WHERE rk <= ${TOP_RULES_PER_SOURCE}
     ORDER BY source_ip, rk
  `) as unknown as { rows: Array<{ source_ip: string; rule_id: string }> }).rows;
  const rulesByIp = new Map<string, string[]>();
  for (const r of topRules) rulesByIp.set(r.source_ip, [...(rulesByIp.get(r.source_ip) ?? []), r.rule_id]);

  const trusted = addressMatcher((await trustedIpsByRoute(db, [routeId])).get(routeId) ?? []);
  const iso = (v: Date | string): string => new Date(v).toISOString();
  return {
    truncated: sources.length > SOURCES_MAX_ROWS,
    rows: shown.map((r): WafLogSourceRow => ({
      sourceIp: r.source_ip,
      requests: Number(r.requests),
      notBlocked: Number(r.not_blocked),
      passReasons: (r.pass_reasons ?? []).filter((p): p is WafPassReason =>
        (WAF_PASS_REASONS as readonly string[]).includes(p)),
      topRules: rulesByIp.get(r.source_ip) ?? [],
      paths: Number(r.paths),
      firstSeenAt: iso(r.first_seen),
      lastSeenAt: iso(r.last_seen),
      trusted: trusted(r.source_ip),
    })),
  };
}

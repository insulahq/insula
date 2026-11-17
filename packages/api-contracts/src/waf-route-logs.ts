/**
 * A route's WAF events as its tenant reads them: the event list (filtered,
 * paged), the events grouped by source IP, and why a request that matched
 * rules was NOT blocked.
 *
 * "Not blocked" has more causes than detection-only mode. ModSecurity's audit
 * record says whether it refused the request (`is_interrupted`). When it did
 * not, the scraper records why:
 *  - allowlisted_ip — the source is on the platform's CrowdSec allowlist,
 *    which the WAF runs in detection-only mode for every site;
 *  - trusted_ip — the source is one of this route's WAF trusted IPs;
 *  - below_threshold — rules matched, but their score stayed under the
 *    blocking threshold;
 *  - not_enforced — the score was over the threshold and no list explains
 *    it (a list changed between the request and the scrape).
 * Null: the request was blocked, or the event was logged before the platform
 * recorded the reason.
 */
import { z } from 'zod';
import { MAX_PAGE_LIMIT } from './shared.js';

export const WAF_PASS_REASONS = ['allowlisted_ip', 'trusted_ip', 'below_threshold', 'not_enforced'] as const;
export const wafPassReasonSchema = z.enum(WAF_PASS_REASONS);
export type WafPassReason = z.infer<typeof wafPassReasonSchema>;

/** How the panels name a pass reason after "not blocked · ". */
export const WAF_PASS_REASON_LABEL: Readonly<Record<WafPassReason, string>> = {
  allowlisted_ip: 'platform allowlist',
  trusted_ip: 'trusted IP',
  below_threshold: 'below threshold',
  not_enforced: 'not enforced',
};

/** One sentence per reason, for a tooltip. */
export const WAF_PASS_REASON_HELP: Readonly<Record<WafPassReason, string>> = {
  allowlisted_ip: 'The source address is on the platform allowlist: the WAF checks and logs its requests on every site but never blocks them.',
  trusted_ip: 'The source address is one of this route\'s WAF trusted IPs: checked and logged, never blocked.',
  below_threshold: 'Rules matched, but the request\'s score stayed below the blocking threshold.',
  not_enforced: 'The WAF did not enforce its verdict on this request.',
};

/** One logged rule match on one request, as the route's WAF log lists it. */
export const routeWafLogEntrySchema = z.object({
  id: z.string(),
  routeId: z.string().nullable(),
  ruleId: z.string(),
  severity: z.string(),
  message: z.string(),
  requestUri: z.string().nullable(),
  requestMethod: z.string().nullable(),
  sourceIp: z.string().nullable(),
  createdAt: z.string(),
  /** Logged while the route's WAF was in detection-only mode: not blocked. */
  detectionOnly: z.boolean(),
  /** Why the WAF let the request through; null = blocked (or not recorded). */
  passReason: wafPassReasonSchema.nullable(),
});
export type RouteWafLogEntry = z.infer<typeof routeWafLogEntrySchema>;

/** Sortable columns of the event list — sorted by the server, over every page. */
export const ROUTE_WAF_LOG_SORT_FIELDS = ['createdAt', 'sourceIp', 'severity', 'ruleId', 'request'] as const;
export type RouteWafLogSortField = (typeof ROUTE_WAF_LOG_SORT_FIELDS)[number];

/** Which requests the event list shows. */
export const ROUTE_WAF_LOG_OUTCOMES = ['all', 'blocked', 'not_blocked'] as const;
export type RouteWafLogOutcome = (typeof ROUTE_WAF_LOG_OUTCOMES)[number];

/** An address as typed into a filter: IPv4 or IPv6 characters only, no wildcards. */
const ipFilter = z.string().trim().min(2).max(45).regex(/^[0-9A-Fa-f.:]+$/, 'source IP filter must be an IPv4 or IPv6 address');

export const routeWafLogsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(50),
  cursor: z.string().max(2048).optional(),
  /** `field:asc|desc`, field from ROUTE_WAF_LOG_SORT_FIELDS. Default createdAt:desc. */
  sort: z.string().max(40).optional(),
  /** Exact source address. */
  sourceIp: ipFilter.optional(),
  /** Exact CRS rule id. */
  ruleId: z.string().trim().regex(/^[0-9]{1,10}$/, 'rule id must be digits').optional(),
  /** Exact request path, without the query string — as the summary groups it. */
  path: z.string().max(2048).regex(/^\//, 'path must start with /').optional(),
  outcome: z.enum(ROUTE_WAF_LOG_OUTCOMES).default('all'),
});
export type RouteWafLogsQuery = z.infer<typeof routeWafLogsQuerySchema>;

/** One source address of a route's WAF events in the window. */
export const wafLogSourceRowSchema = z.object({
  sourceIp: z.string(),
  /** Distinct requests from this address that matched rules. */
  requests: z.number().int(),
  /** Of those, how many the WAF let through (detection-only, or a pass reason). */
  notBlocked: z.number().int(),
  /** Why, when some were let through — each reason once. */
  passReasons: z.array(wafPassReasonSchema),
  /** The rules it matched most, most first (at most 5). */
  topRules: z.array(z.string()),
  /** Distinct request paths. */
  paths: z.number().int(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  /** The address is covered by one of this route's WAF trusted IPs today. */
  trusted: z.boolean(),
});
export type WafLogSourceRow = z.infer<typeof wafLogSourceRowSchema>;

export const wafLogSourcesResponseSchema = z.object({
  rows: z.array(wafLogSourceRowSchema),
  /** More addresses exist than were returned. */
  truncated: z.boolean(),
});
export type WafLogSourcesResponse = z.infer<typeof wafLogSourcesResponseSchema>;

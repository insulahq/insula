/**
 * Complaint queries (R4 PR 3).
 *
 * Rates follow the original sending-limits spec: complaints over a
 * rolling window divided by SENDS over the same window (the R6 PR 2
 * counters are the denominator). Provider guidance: > 0.1% (7d) is
 * throttle territory, > 0.3% is suspend territory — acted on in PR 4.
 */

import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { emailFblComplaints, emailSendCounters, tenants } from '../../db/schema.js';
import { encodeCursor, decodeCursor } from '../../shared/pagination.js';
import type { Database } from '../../db/index.js';
import type { PaginationMeta } from '../../shared/response.js';
import type { ComplaintSummaryEntry, FblComplaint } from '@insula/api-contracts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function listComplaints(
  db: Database,
  params: { tenantId?: string; domain?: string; limit?: number; cursor?: string },
): Promise<{ data: FblComplaint[]; pagination: PaginationMeta }> {
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const conditions = [];
  if (params.tenantId) conditions.push(eq(emailFblComplaints.tenantId, params.tenantId));
  if (params.domain) conditions.push(eq(emailFblComplaints.domain, params.domain.toLowerCase()));
  if (params.cursor) {
    // decodeCursor THROWS ApiError(INVALID_CURSOR, 400) on garbage —
    // intentionally not caught: Fastify's error handler maps it to a
    // clean 400 envelope. Cursor sort key = receivedAt ISO string.
    const decoded = decodeCursor(params.cursor);
    const ts = new Date(decoded.sort);
    if (Number.isFinite(ts.getTime())) {
      conditions.push(lt(emailFblComplaints.receivedAt, ts));
    }
  }

  const rows = await db
    .select()
    .from(emailFblComplaints)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(emailFblComplaints.receivedAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit) as unknown as FblComplaint[];
  const cursor = hasMore && page.length > 0
    ? encodeCursor({
      resource: 'mail-complaints',
      sort: rows[limit - 1].receivedAt.toISOString(),
      id: rows[limit - 1].id,
    })
    : null;

  return { data: page, pagination: { cursor, has_more: hasMore, page_size: limit } };
}

/**
 * Per-domain complaint counts and rates for 7d/30d windows, joined
 * with send totals. Only domains with at least one complaint OR at
 * least one send in 30d appear.
 */
export async function complaintSummary(db: Database): Promise<ComplaintSummaryEntry[]> {
  const complaintRowsP = db
    .select({
      tenantId: emailFblComplaints.tenantId,
      domain: emailFblComplaints.domain,
      complaints7d: sql<number>`COALESCE(SUM(${emailFblComplaints.incidents}) FILTER (WHERE ${emailFblComplaints.receivedAt} >= NOW() - INTERVAL '7 days'), 0)`,
      complaints30d: sql<number>`COALESCE(SUM(${emailFblComplaints.incidents}), 0)`,
      lastComplaintAt: sql<string | null>`MAX(${emailFblComplaints.receivedAt})`,
    })
    .from(emailFblComplaints)
    .where(gte(emailFblComplaints.receivedAt, sql`NOW() - INTERVAL '30 days'`))
    .groupBy(emailFblComplaints.tenantId, emailFblComplaints.domain);

  const sendRowsP = db
    .select({
      tenantId: emailSendCounters.tenantId,
      domain: emailSendCounters.domain,
      sent7d: sql<number>`COALESCE(SUM(${emailSendCounters.sentCount}) FILTER (WHERE ${emailSendCounters.bucketStart} >= NOW() - INTERVAL '7 days'), 0)`,
      sent30d: sql<number>`COALESCE(SUM(${emailSendCounters.sentCount}), 0)`,
    })
    .from(emailSendCounters)
    .where(gte(emailSendCounters.bucketStart, sql`NOW() - INTERVAL '30 days'`))
    .groupBy(emailSendCounters.tenantId, emailSendCounters.domain);

  const [complaintRows, sendRows] = await Promise.all([complaintRowsP, sendRowsP]);

  const tenantNames = new Map<string, string>();
  {
    const ids = new Set<string>();
    for (const r of complaintRows) if (r.tenantId) ids.add(r.tenantId);
    for (const r of sendRows) ids.add(r.tenantId);
    if (ids.size > 0) {
      const rows = await db
        .select({ id: tenants.id, name: tenants.name })
        .from(tenants)
        .where(inArray(tenants.id, [...ids]));
      for (const r of rows) tenantNames.set(r.id, r.name);
    }
  }

  const byKey = new Map<string, ComplaintSummaryEntry>();
  const keyOf = (tenantId: string | null, domain: string | null) => `${tenantId ?? ''}|${domain ?? ''}`;

  for (const r of sendRows) {
    byKey.set(keyOf(r.tenantId, r.domain), {
      tenantId: r.tenantId,
      tenantName: tenantNames.get(r.tenantId) ?? null,
      domain: r.domain,
      sent7d: Number(r.sent7d),
      sent30d: Number(r.sent30d),
      complaints7d: 0,
      complaints30d: 0,
      complaintRate7d: 0,
      complaintRate30d: 0,
      lastComplaintAt: null,
    });
  }

  for (const r of complaintRows) {
    const key = keyOf(r.tenantId, r.domain);
    const existing = byKey.get(key) ?? {
      tenantId: r.tenantId,
      tenantName: r.tenantId ? (tenantNames.get(r.tenantId) ?? null) : null,
      domain: r.domain,
      sent7d: 0,
      sent30d: 0,
      complaints7d: 0,
      complaints30d: 0,
      complaintRate7d: 0,
      complaintRate30d: 0,
      lastComplaintAt: null,
    };
    byKey.set(key, {
      ...existing,
      complaints7d: Number(r.complaints7d),
      complaints30d: Number(r.complaints30d),
      lastComplaintAt: r.lastComplaintAt,
    });
  }

  return [...byKey.values()]
    .map((e) => ({
      ...e,
      // Rate = complaints / sends; with a zero denominator but real
      // complaints the rate is reported as 1 (100%) so thresholds in
      // PR 4 treat "complaints with no recorded sends" as maximal.
      complaintRate7d: e.complaints7d === 0 ? 0 : (e.sent7d > 0 ? e.complaints7d / e.sent7d : 1),
      complaintRate30d: e.complaints30d === 0 ? 0 : (e.sent30d > 0 ? e.complaints30d / e.sent30d : 1),
    }))
    .sort((a, b) => b.complaintRate7d - a.complaintRate7d || b.sent7d - a.sent7d);
}

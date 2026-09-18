/**
 * Read side for ingested abuse reports.
 *
 * Deliberately a list, not a summary. The DMARC surface next door aggregates
 * because a single DMARC record means nothing on its own — the signal is the
 * trend. A complaint is the opposite: one of them is the event, and rolling it
 * into a count per domain would hide the line that says which message and who
 * complained. So this returns rows, newest first, with a count for the window.
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { emailAbuseReports, tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { AbuseReport } from '@insula/api-contracts';

/** Matches the DMARC surface so the two read as one feature. */
export const ABUSE_WINDOW_DAYS = 30;

const DEFAULT_LIMIT = 100;

export interface AbuseReportQuery {
  readonly windowDays?: number;
  readonly limit?: number;
  readonly feedbackType?: string;
  /** Scope to one tenant. Omitted for the admin estate-wide view. */
  readonly tenantId?: string;
}

/**
 * Rows for the window, newest first, plus the true total.
 *
 * `total` is counted separately rather than taken from `rows.length`, or a
 * capped list would report the cap as the number of complaints — the operator
 * would read "100 complaints" as the whole truth exactly when it is not.
 */
export async function listAbuseReports(
  db: Database,
  query: AbuseReportQuery = {},
): Promise<{ reports: AbuseReport[]; total: number; windowDays: number }> {
  const windowDays = query.windowDays ?? ABUSE_WINDOW_DAYS;
  const limit = Math.min(query.limit ?? DEFAULT_LIMIT, 200);
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const filters = [gte(emailAbuseReports.receivedAt, since)];
  if (query.feedbackType) filters.push(eq(emailAbuseReports.feedbackType, query.feedbackType));
  // A tenant may only ever see its own. Applied as a WHERE, not a post-filter,
  // so a paging cap can never leak another tenant's row into the page.
  if (query.tenantId) filters.push(eq(emailAbuseReports.tenantId, query.tenantId));
  const where = and(...filters);

  const rows = await db
    .select({
      id: emailAbuseReports.id,
      feedbackType: emailAbuseReports.feedbackType,
      domain: emailAbuseReports.domain,
      tenantId: emailAbuseReports.tenantId,
      tenantName: tenants.name,
      originalMailFrom: emailAbuseReports.originalMailFrom,
      originalRcptTo: emailAbuseReports.originalRcptTo,
      sourceIp: emailAbuseReports.sourceIp,
      reportingMta: emailAbuseReports.reportingMta,
      reporter: emailAbuseReports.reporter,
      subject: emailAbuseReports.subject,
      incidents: emailAbuseReports.incidents,
      receivedAt: emailAbuseReports.receivedAt,
    })
    .from(emailAbuseReports)
    // LEFT join: tenant_id is nullable by design (unattributed complaints, and
    // rows that outlive a deleted tenant). An inner join would drop exactly the
    // reports that need a human most.
    .leftJoin(tenants, eq(emailAbuseReports.tenantId, tenants.id))
    .where(where)
    .orderBy(desc(emailAbuseReports.receivedAt))
    .limit(limit);

  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(emailAbuseReports)
    .where(where);

  return {
    windowDays,
    total: counted?.total ?? 0,
    reports: rows.map((r) => ({
      id: r.id,
      feedbackType: normaliseType(r.feedbackType),
      domain: r.domain,
      tenantId: r.tenantId,
      tenantName: r.tenantName ?? null,
      originalMailFrom: r.originalMailFrom,
      originalRcptTo: r.originalRcptTo,
      sourceIp: r.sourceIp,
      reportingMta: r.reportingMta,
      reporter: r.reporter,
      subject: r.subject,
      incidents: r.incidents,
      receivedAt: r.receivedAt.toISOString(),
    })),
  };
}

/**
 * Collapse anything outside the contract's enum to `other`.
 *
 * ARF is extensible, so a feedback type the platform has never seen is a
 * question of when, not if. Widening it here keeps a new value from failing
 * response validation and blanking a page that is meant to show incidents.
 */
function normaliseType(value: string): AbuseReport['feedbackType'] {
  return value === 'abuse' || value === 'fraud' || value === 'virus' ? value : 'other';
}

/**
 * Read side for ingested TLS-RPT reports.
 *
 * A list of reports plus session totals for the window. The totals matter more
 * than they do for abuse: a failure count on its own is unreadable — "12
 * failed sessions" is a crisis at a small domain and background noise at a
 * large one — so the denominator travels with it, the same discipline the
 * DMARC pass rate uses.
 */

import { and, desc, eq, gt, gte, sql } from 'drizzle-orm';
import { emailTlsReports, tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { TlsReport, TlsFailure } from '@insula/api-contracts';

export const TLS_WINDOW_DAYS = 30;

const DEFAULT_LIMIT = 100;

export interface TlsReportQuery {
  readonly windowDays?: number;
  readonly limit?: number;
  readonly failingOnly?: boolean;
  /** Scope to one tenant. Omitted for the admin estate-wide view. */
  readonly tenantId?: string;
}

export interface TlsReportsResult {
  readonly reports: TlsReport[];
  readonly total: number;
  readonly windowDays: number;
  readonly totalSuccessfulSessions: number;
  readonly totalFailedSessions: number;
  readonly successRate: number | null;
}

export async function listTlsReports(
  db: Database,
  query: TlsReportQuery = {},
): Promise<TlsReportsResult> {
  const windowDays = query.windowDays ?? TLS_WINDOW_DAYS;
  const limit = Math.min(query.limit ?? DEFAULT_LIMIT, 200);
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const filters = [gte(emailTlsReports.receivedAt, since)];
  if (query.tenantId) filters.push(eq(emailTlsReports.tenantId, query.tenantId));
  // Totals are deliberately computed over the UNFILTERED window below, so the
  // denominator does not move when the operator ticks "failing only" — a rate
  // that changes with the filter is worse than no rate.
  const windowWhere = and(...filters);
  const listWhere = query.failingOnly
    ? and(...filters, gt(emailTlsReports.failedSessions, 0))
    : windowWhere;

  const rows = await db
    .select({
      id: emailTlsReports.id,
      policyDomain: emailTlsReports.policyDomain,
      tenantId: emailTlsReports.tenantId,
      tenantName: tenants.name,
      orgName: emailTlsReports.orgName,
      contactInfo: emailTlsReports.contactInfo,
      reportId: emailTlsReports.reportId,
      dateRangeStart: emailTlsReports.dateRangeStart,
      dateRangeEnd: emailTlsReports.dateRangeEnd,
      successfulSessions: emailTlsReports.successfulSessions,
      failedSessions: emailTlsReports.failedSessions,
      failures: emailTlsReports.failures,
      receivedAt: emailTlsReports.receivedAt,
    })
    .from(emailTlsReports)
    // LEFT: policy_domain may not resolve to a tenant (the platform hostname
    // publishes TLS-RPT too, and it belongs to no tenant).
    .leftJoin(tenants, eq(emailTlsReports.tenantId, tenants.id))
    .where(listWhere)
    .orderBy(desc(emailTlsReports.receivedAt))
    .limit(limit);

  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(emailTlsReports)
    .where(listWhere);

  const [sums] = await db
    .select({
      ok: sql<number>`coalesce(sum(${emailTlsReports.successfulSessions}), 0)::int`,
      bad: sql<number>`coalesce(sum(${emailTlsReports.failedSessions}), 0)::int`,
    })
    .from(emailTlsReports)
    .where(windowWhere);

  const ok = sums?.ok ?? 0;
  const bad = sums?.bad ?? 0;
  const sessions = ok + bad;

  return {
    windowDays,
    total: counted?.total ?? 0,
    totalSuccessfulSessions: ok,
    totalFailedSessions: bad,
    // Null, not 1, when nothing was reported. "100% of nothing" is the figure
    // that gets acted on when it should not be.
    successRate: sessions > 0 ? ok / sessions : null,
    reports: rows.map((r) => ({
      id: r.id,
      policyDomain: r.policyDomain,
      tenantId: r.tenantId,
      tenantName: r.tenantName ?? null,
      orgName: r.orgName,
      contactInfo: r.contactInfo,
      reportId: r.reportId,
      dateRangeStart: r.dateRangeStart?.toISOString() ?? null,
      dateRangeEnd: r.dateRangeEnd?.toISOString() ?? null,
      successfulSessions: r.successfulSessions,
      failedSessions: r.failedSessions,
      failures: (r.failures ?? []) as unknown as TlsFailure[],
      receivedAt: r.receivedAt.toISOString(),
    })),
  };
}

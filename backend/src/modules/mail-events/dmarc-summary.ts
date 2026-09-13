/**
 * DMARC read model (ROADMAP R5).
 *
 * Aggregates the ingested reports into the two answers an operator needs:
 *
 *   1. **Per domain** — is our mail authenticating, and may we tighten the
 *      published policy yet?
 *   2. **Per source IP** — which senders are failing, worst first. This is the
 *      actionable half: a pass rate says something is wrong, a source row says
 *      *what*.
 *
 * Every number here is computed over an explicit trailing window and reported
 * alongside its denominator. A pass rate with no message count is exactly the
 * kind of figure that gets acted on when it should not be — "100%" over eleven
 * messages is one quiet week, not evidence.
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { emailDmarcReports, emailDmarcSources } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import {
  recommendPolicy,
  type DmarcPolicy,
  type DmarcRecommendation,
} from './dmarc-policy.js';

/** Default trailing window. 30 days covers a monthly-cadence sender. */
export const DMARC_WINDOW_DAYS = 30;

export interface DmarcDomainSummary {
  readonly policyDomain: string;
  readonly tenantId: string | null;
  readonly reportCount: number;
  readonly totalMessages: number;
  readonly passMessages: number;
  readonly failMessages: number;
  readonly dkimPassMessages: number;
  readonly spfPassMessages: number;
  readonly quarantinedMessages: number;
  readonly rejectedMessages: number;
  /**
   * Null — never 0 or 1 — when there is no denominator. A rate computed from
   * nothing is undefined, and rendering it as 0% (catastrophe) or 100% (all
   * clear) are both claims the data does not support.
   */
  readonly passRate: number | null;
  readonly currentPolicy: DmarcPolicy | null;
  readonly firstReportAt: string | null;
  readonly lastReportAt: string | null;
  readonly windowDays: number;
  readonly failingSources: number;
  readonly recommendation: DmarcRecommendation;
}

function asPolicy(v: string | null): DmarcPolicy | null {
  return v === 'none' || v === 'quarantine' || v === 'reject' ? v : null;
}

/** Whole days spanned by two timestamps, floored at 0. */
function spanDays(first: Date | null, last: Date | null): number {
  if (!first || !last) return 0;
  return Math.max(0, Math.floor((last.getTime() - first.getTime()) / 86_400_000));
}

/**
 * Per-domain summary over the trailing window.
 *
 * The failing-source count is a SEPARATE query rather than a join, because it
 * counts DISTINCT source IPs that failed — folding it into the report-level
 * aggregate would multiply the message sums by the number of source rows, and
 * the resulting pass rate would look plausible while being wrong.
 */
export async function dmarcDomainSummaries(
  db: Database,
  opts: { windowDays?: number; tenantId?: string; now?: Date } = {},
): Promise<DmarcDomainSummary[]> {
  const windowDays = opts.windowDays ?? DMARC_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 86_400_000);

  const scope = opts.tenantId
    ? and(gte(emailDmarcReports.receivedAt, since), eq(emailDmarcReports.tenantId, opts.tenantId))
    : gte(emailDmarcReports.receivedAt, since);

  const rows = await db
    .select({
      policyDomain: emailDmarcReports.policyDomain,
      tenantId: sql<string | null>`MAX(${emailDmarcReports.tenantId})`,
      reportCount: sql<number>`COUNT(*)::int`,
      totalMessages: sql<number>`COALESCE(SUM(${emailDmarcReports.totalMessages}), 0)::int`,
      passMessages: sql<number>`COALESCE(SUM(${emailDmarcReports.passMessages}), 0)::int`,
      failMessages: sql<number>`COALESCE(SUM(${emailDmarcReports.failMessages}), 0)::int`,
      dkimPassMessages: sql<number>`COALESCE(SUM(${emailDmarcReports.dkimPassMessages}), 0)::int`,
      spfPassMessages: sql<number>`COALESCE(SUM(${emailDmarcReports.spfPassMessages}), 0)::int`,
      quarantinedMessages: sql<number>`COALESCE(SUM(${emailDmarcReports.quarantinedMessages}), 0)::int`,
      rejectedMessages: sql<number>`COALESCE(SUM(${emailDmarcReports.rejectedMessages}), 0)::int`,
      firstReportAt: sql<Date | null>`MIN(${emailDmarcReports.receivedAt})`,
      lastReportAt: sql<Date | null>`MAX(${emailDmarcReports.receivedAt})`,
      // The policy the reporters most recently observed published. Reporters
      // echo what they resolved, so this is the live record rather than what
      // the platform believes it published.
      latestPolicy: sql<string | null>`(ARRAY_AGG(${emailDmarcReports.policyDisposition} ORDER BY ${emailDmarcReports.receivedAt} DESC))[1]`,
    })
    .from(emailDmarcReports)
    .where(scope)
    .groupBy(emailDmarcReports.policyDomain);

  const failing = await db
    .select({
      policyDomain: emailDmarcSources.policyDomain,
      failingSources: sql<number>`COUNT(DISTINCT ${emailDmarcSources.sourceIp})::int`,
    })
    .from(emailDmarcSources)
    .where(and(
      gte(emailDmarcSources.receivedAt, since),
      // "Failed" means DMARC failed: neither mechanism passed. A row where DKIM
      // failed but SPF passed is a PASS and must not be counted here, or every
      // domain using one mechanism would look permanently broken.
      sql`${emailDmarcSources.evaluatedDkim} IS DISTINCT FROM 'pass'`,
      sql`${emailDmarcSources.evaluatedSpf} IS DISTINCT FROM 'pass'`,
    ))
    .groupBy(emailDmarcSources.policyDomain);

  const failingByDomain = new Map<string, number>();
  for (const f of failing) {
    if (f.policyDomain) failingByDomain.set(f.policyDomain, f.failingSources);
  }

  return rows
    .filter((r): r is typeof r & { policyDomain: string } => typeof r.policyDomain === 'string')
    .map((r) => {
      const first = r.firstReportAt ? new Date(r.firstReportAt) : null;
      const last = r.lastReportAt ? new Date(r.lastReportAt) : null;
      const windowSpan = spanDays(first, last);
      const currentPolicy = asPolicy(r.latestPolicy);
      const failingSources = failingByDomain.get(r.policyDomain) ?? 0;
      return {
        policyDomain: r.policyDomain,
        tenantId: r.tenantId ?? null,
        reportCount: r.reportCount,
        totalMessages: r.totalMessages,
        passMessages: r.passMessages,
        failMessages: r.failMessages,
        dkimPassMessages: r.dkimPassMessages,
        spfPassMessages: r.spfPassMessages,
        quarantinedMessages: r.quarantinedMessages,
        rejectedMessages: r.rejectedMessages,
        passRate: r.totalMessages > 0 ? r.passMessages / r.totalMessages : null,
        currentPolicy,
        firstReportAt: first ? first.toISOString() : null,
        lastReportAt: last ? last.toISOString() : null,
        windowDays: windowSpan,
        failingSources,
        recommendation: recommendPolicy({
          policyDomain: r.policyDomain,
          currentPolicy,
          reportCount: r.reportCount,
          totalMessages: r.totalMessages,
          passMessages: r.passMessages,
          windowDays: windowSpan,
          failingSources,
        }),
      };
    })
    .sort((a, b) => b.totalMessages - a.totalMessages);
}

export interface DmarcSourceSummary {
  readonly sourceIp: string;
  readonly policyDomain: string | null;
  readonly messageCount: number;
  readonly passCount: number;
  readonly failCount: number;
  readonly lastSeenAt: string | null;
}

/**
 * Per-source breakdown for one domain — the actionable half.
 *
 * Ordered by FAILING messages, not by total: the biggest sender is rarely the
 * problem, and sorting by volume buries the one misconfigured host under the
 * mail that is working.
 */
export async function dmarcSourcesForDomain(
  db: Database,
  policyDomain: string,
  opts: { windowDays?: number; limit?: number; now?: Date } = {},
): Promise<DmarcSourceSummary[]> {
  const windowDays = opts.windowDays ?? DMARC_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 86_400_000);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  const passExpr = sql<number>`COALESCE(SUM(CASE WHEN ${emailDmarcSources.evaluatedDkim} = 'pass' OR ${emailDmarcSources.evaluatedSpf} = 'pass' THEN ${emailDmarcSources.messageCount} ELSE 0 END), 0)::int`;
  const failExpr = sql<number>`COALESCE(SUM(CASE WHEN ${emailDmarcSources.evaluatedDkim} IS DISTINCT FROM 'pass' AND ${emailDmarcSources.evaluatedSpf} IS DISTINCT FROM 'pass' THEN ${emailDmarcSources.messageCount} ELSE 0 END), 0)::int`;

  const rows = await db
    .select({
      sourceIp: emailDmarcSources.sourceIp,
      policyDomain: emailDmarcSources.policyDomain,
      messageCount: sql<number>`COALESCE(SUM(${emailDmarcSources.messageCount}), 0)::int`,
      passCount: passExpr,
      failCount: failExpr,
      lastSeenAt: sql<Date | null>`MAX(${emailDmarcSources.receivedAt})`,
    })
    .from(emailDmarcSources)
    .where(and(
      eq(emailDmarcSources.policyDomain, policyDomain.toLowerCase()),
      gte(emailDmarcSources.receivedAt, since),
    ))
    .groupBy(emailDmarcSources.sourceIp, emailDmarcSources.policyDomain)
    .orderBy(desc(failExpr))
    .limit(limit);

  return rows
    .filter((r): r is typeof r & { sourceIp: string } => typeof r.sourceIp === 'string')
    .map((r) => ({
      sourceIp: r.sourceIp,
      policyDomain: r.policyDomain ?? null,
      messageCount: r.messageCount,
      passCount: r.passCount,
      failCount: r.failCount,
      lastSeenAt: r.lastSeenAt ? new Date(r.lastSeenAt).toISOString() : null,
    }));
}

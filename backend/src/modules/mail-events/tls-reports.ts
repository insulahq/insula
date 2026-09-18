/**
 * TLS-RPT ingestion (RFC 8460).
 *
 * Every mail-enabled domain publishes `_smtp._tls.<domain> TXT "v=TLSRPTv1;
 * rua=mailto:postmaster@<domain>"`, so receivers report back daily on whether
 * they could negotiate TLS to our MX. Stalwart parses those into
 * `x:TlsExternalReport` objects; this module polls them, attributes each to a
 * tenant by policy domain, persists it, and destroys what it consumed.
 *
 * The subject is INBOUND delivery TO this platform. A failure means somebody
 * could not deliver to us securely — an expired certificate, an MTA-STS policy
 * that stopped matching, a stale MX record. That is ours to fix, which is why
 * it is worth storing rather than letting Stalwart expire it silently.
 *
 * Why there is no notification here
 * ---------------------------------
 * Unlike an abuse report, a TLS report is a periodic SUMMARY, not an incident:
 * one arrives per reporting operator per day whether anything is wrong or not,
 * and a healthy estate produces a steady stream of them. Alerting per report
 * would be pure noise, and alerting per failure would fire on the single
 * transient session every large receiver records. The surfaces show the
 * failures; a threshold on top of them is a separate decision that needs a
 * baseline nobody has yet.
 */

import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { emailTlsReports, emailDomains, domains } from '../../db/schema.js';
import {
  tlsExternalReportList,
  tlsExternalReportDestroy,
  type StalwartTlsReportRow,
  type StalwartTlsReportPolicy,
  type StalwartTlsFailureDetails,
} from '../stalwart-jmap/client.js';
import type { Database } from '../../db/index.js';
import type { OutboundReconcileLogger } from '../email-outbound/service.js';

export interface TlsReportPollResult {
  readonly fetched: number;
  readonly stored: number;
  readonly destroyed: number;
}

const EMPTY: TlsReportPollResult = { fetched: 0, stored: 0, destroyed: 0 };

/**
 * `List<T>` on the wire is an object keyed by decimal-string INDEX
 * (`{"0": …, "1": …}`), not an array. `.map()` over it yields nothing and
 * reports a clean zero, which for this feature would mean "TLS is fine".
 */
function listValues<T>(value: Record<string, T> | undefined | null): T[] {
  if (!value || typeof value !== 'object') return [];
  return Object.values(value);
}

/** `Map<String>` is keyed BY VALUE (`{"mx.example.test": true}`). */
function mapKeys(value: Record<string, boolean> | undefined | null): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.keys(value).filter((k) => value[k]);
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function cap(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

export interface FlattenedFailure {
  readonly resultType: string;
  readonly failedSessionCount: number;
  readonly receivingMxHostname: string | null;
  readonly sendingMtaIp: string | null;
  readonly failureReasonCode: string | null;
  readonly additionalInformation: string | null;
}

export interface SummarisedTlsReport {
  readonly policyDomain: string | null;
  readonly successfulSessions: number;
  readonly failedSessions: number;
  readonly failures: FlattenedFailure[];
  readonly mxHosts: string[];
}

/**
 * Flatten every policy in a report into one set of totals plus the failure
 * detail, so the row answers "did delivery to us work, and if not how".
 *
 * Exported for unit coverage: the index-keyed shape is the single easiest
 * thing to get wrong here, and getting it wrong reports zero failures.
 */
export function summariseReport(report: StalwartTlsReportRow): SummarisedTlsReport {
  const policies: StalwartTlsReportPolicy[] = listValues(report.report?.policies);
  let successfulSessions = 0;
  let failedSessions = 0;
  const failures: FlattenedFailure[] = [];
  const mxHosts = new Set<string>();
  let policyDomain: string | null = null;

  for (const policy of policies) {
    successfulSessions += Math.max(0, Math.trunc(policy.totalSuccessfulSessions ?? 0));
    failedSessions += Math.max(0, Math.trunc(policy.totalFailedSessions ?? 0));
    if (!policyDomain && typeof policy.policyDomain === 'string' && policy.policyDomain.trim()) {
      policyDomain = policy.policyDomain.trim().toLowerCase().replace(/\.+$/, '');
    }
    for (const host of mapKeys(policy.mxHosts)) mxHosts.add(host);
    for (const detail of listValues<StalwartTlsFailureDetails>(policy.failureDetails)) {
      failures.push({
        resultType: cap(detail.resultType, 64) ?? 'unknown',
        failedSessionCount: Math.max(0, Math.trunc(detail.failedSessionCount ?? 0)),
        receivingMxHostname: cap(detail.receivingMxHostname, 255),
        sendingMtaIp: cap(detail.sendingMtaIp, 64),
        failureReasonCode: cap(detail.failureReasonCode, 128),
        additionalInformation: cap(detail.additionalInformation, 1000),
      });
    }
  }

  return {
    policyDomain,
    successfulSessions,
    failedSessions,
    failures,
    mxHosts: Array.from(mxHosts),
  };
}

/** Which tenant owns the reported policy domain, if any. */
async function attributeDomain(
  db: Database,
  policyDomain: string | null,
): Promise<string | null> {
  if (!policyDomain) return null;
  const rows = await db
    .select({ tenantId: emailDomains.tenantId })
    .from(emailDomains)
    .innerJoin(domains, eq(emailDomains.domainId, domains.id))
    .where(inArray(sql`lower(${domains.domainName})`, [policyDomain]));
  return rows[0]?.tenantId ?? null;
}

/**
 * Poll, persist, destroy. Never throws — it runs on the mail self-heal tick,
 * where one failing reconciler must not stop the others.
 */
export async function pollTlsReports(
  db: Database,
  logger: OutboundReconcileLogger,
  opts: { baseUrl?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<TlsReportPollResult> {
  let reports: readonly StalwartTlsReportRow[];
  try {
    reports = await tlsExternalReportList(opts);
  } catch (err) {
    logger.warn({ err }, 'tls reports: Stalwart JMAP unreachable, skipped');
    return EMPTY;
  }
  if (reports.length === 0) return EMPTY;

  let stored = 0;
  const consumed: string[] = [];

  for (const report of reports) {
    try {
      const summary = summariseReport(report);
      const tenantId = await attributeDomain(db, summary.policyDomain);
      const inserted = await db
        .insert(emailTlsReports)
        .values({
          id: randomUUID(),
          stalwartReportId: report.id,
          tenantId,
          policyDomain: cap(summary.policyDomain, 255),
          orgName: cap(report.report?.organizationName, 255),
          contactInfo: cap(report.report?.contactInfo, 320),
          reportId: cap(report.report?.reportId, 255),
          dateRangeStart: parseDate(report.report?.dateRangeStart),
          dateRangeEnd: parseDate(report.report?.dateRangeEnd),
          successfulSessions: summary.successfulSessions,
          failedSessions: summary.failedSessions,
          failures: summary.failures as unknown as Array<Record<string, unknown>>,
          receivedAt: parseDate(report.receivedAt) ?? new Date(),
          raw: report as unknown as Record<string, unknown>,
        })
        // The object is destroyed only after the row commits, so a redelivery
        // after a mid-poll crash is expected rather than an error.
        .onConflictDoNothing({ target: emailTlsReports.stalwartReportId })
        .returning({ id: emailTlsReports.id });

      if (inserted.length > 0) stored += 1;
      consumed.push(report.id);
      if (summary.failedSessions > 0) {
        // Logged at info, not warn: a handful of failed sessions is normal at
        // any real receiver, and a warn per report would train operators to
        // ignore the channel. The surfaces carry the judgement.
        logger.info(
          {
            reportId: report.id,
            policyDomain: summary.policyDomain,
            failed: summary.failedSessions,
            successful: summary.successfulSessions,
            resultTypes: summary.failures.map((f) => f.resultType),
          },
          'tls reports: ingested a report WITH failed sessions',
        );
      }
    } catch (err) {
      // Not added to `consumed` — destroying an unstored report loses it.
      logger.error({ err, reportId: report.id }, 'tls reports: failed to persist a report');
    }
  }

  let destroyed = 0;
  if (consumed.length > 0) {
    try {
      const res = await tlsExternalReportDestroy({ ids: consumed, ...opts });
      destroyed = consumed.length - Object.keys(res.notDestroyed ?? {}).length;
      if (res.notDestroyed && Object.keys(res.notDestroyed).length > 0) {
        logger.warn({ notDestroyed: res.notDestroyed }, 'tls reports: some reports not destroyed (will dedupe next poll)');
      }
    } catch (err) {
      logger.warn({ err }, 'tls reports: destroy of consumed reports failed (will dedupe next poll)');
    }
  }

  logger.info({ fetched: reports.length, stored, destroyed }, 'tls reports: poll complete');
  return { fetched: reports.length, stored, destroyed };
}

/**
 * FBL complaint ingestion (R4 PR 3).
 *
 * Stalwart's report-analysis intercepts mail to the configured report
 * addresses, parses ARF (and DMARC/TLS) reports, and stores them as
 * x:ArfExternalReport registry objects. This module:
 *
 *   1. polls those objects (5-min self-heal tick + a debounced
 *      immediate poll when an incoming-report.* webhook event arrives),
 *   2. attributes each complaint to a tenant — by reported domain
 *      first, falling back to the original MAIL FROM domain,
 *   3. persists one row per report into email_fbl_complaints
 *      (idempotent on the Stalwart report id),
 *   4. destroys the consumed objects so the Stalwart store stays small.
 *
 * Complaint RATES (complaints / sends over 7d/30d) are computed on
 * read against email_send_counters — see routes.ts. Thresholds and
 * notifications are R4 PR 4.
 */

import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { emailDomains, domains, emailFblComplaints } from '../../db/schema.js';
import {
  arfExternalReportList,
  arfExternalReportDestroy,
  type StalwartArfReportRow,
} from '../stalwart-jmap/client.js';
import type { Database } from '../../db/index.js';
import type { OutboundReconcileLogger } from '../email-outbound/service.js';

export interface ComplaintRow {
  readonly id: string;
  readonly stalwartReportId: string;
  readonly tenantId: string | null;
  readonly domain: string | null;
  readonly feedbackType: string;
  readonly originalMailFrom: string | null;
  readonly originalRcptTo: string | null;
  readonly sourceIp: string | null;
  readonly reportingMta: string | null;
  readonly reporter: string | null;
  readonly incidents: number;
  readonly receivedAt: Date;
  readonly raw: Record<string, unknown>;
}

function stripAngles(addr: string | null | undefined): string | null {
  if (!addr) return null;
  const v = addr.trim().replace(/^<|>$/g, '');
  return v.length > 0 ? v : null;
}

function domainOfAddress(addr: string | null): string | null {
  if (!addr) return null;
  const at = addr.lastIndexOf('@');
  if (at < 1 || at === addr.length - 1) return null;
  return addr.slice(at + 1).toLowerCase();
}

/**
 * Pure: one Stalwart report -> a complaint row. The candidate domains
 * (reportedDomains, then the original MAIL FROM domain) are checked
 * against the platform's email domains via `resolve`; the first hit
 * wins. Unattributed complaints are kept (tenant/domain null) — they
 * still matter for platform-level reputation.
 */
export function mapArfReport(
  report: StalwartArfReportRow,
  resolve: (domain: string) => string | undefined,
): ComplaintRow {
  const r = report.report ?? {};
  const originalMailFrom = stripAngles(r.originalMailFrom);
  const candidates: string[] = [
    ...Object.keys(r.reportedDomains ?? {}).map((d) => d.toLowerCase()),
    ...(domainOfAddress(originalMailFrom) ? [domainOfAddress(originalMailFrom) as string] : []),
  ];

  let tenantId: string | null = null;
  let domain: string | null = null;
  for (const c of candidates) {
    const t = resolve(c);
    if (t) {
      tenantId = t;
      domain = c;
      break;
    }
  }
  if (!domain && candidates.length > 0) domain = candidates[0];

  const receivedAt = report.receivedAt ? new Date(report.receivedAt) : new Date();

  return {
    id: randomUUID(),
    stalwartReportId: report.id,
    tenantId,
    domain,
    feedbackType: (r.feedbackType ?? 'other').toLowerCase(),
    originalMailFrom,
    originalRcptTo: stripAngles(r.originalRcptTo),
    sourceIp: r.sourceIp ?? null,
    reportingMta: r.reportingMta ?? null,
    reporter: report.from ?? null,
    incidents: typeof r.incidents === 'number' && r.incidents > 0 ? r.incidents : 1,
    receivedAt: Number.isFinite(receivedAt.getTime()) ? receivedAt : new Date(),
    raw: { report: r, subject: report.subject ?? null, to: report.to ?? null },
  };
}

export interface FblPollResult {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly fetched: number;
  readonly stored: number;
  readonly destroyed: number;
}

export async function pollFblComplaints(
  db: Database,
  logger: OutboundReconcileLogger,
  opts: { baseUrl?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<FblPollResult> {
  let reports: readonly StalwartArfReportRow[];
  try {
    reports = await arfExternalReportList(opts);
  } catch (err) {
    logger.warn({ err }, 'fbl poll: Stalwart JMAP unreachable, skipped');
    return { skipped: true, reason: 'stalwart unreachable', fetched: 0, stored: 0, destroyed: 0 };
  }
  if (reports.length === 0) {
    return { skipped: false, fetched: 0, stored: 0, destroyed: 0 };
  }

  // Resolve every candidate domain in one query.
  const wanted = new Set<string>();
  for (const rep of reports) {
    for (const d of Object.keys(rep.report?.reportedDomains ?? {})) wanted.add(d.toLowerCase());
    const fromDomain = domainOfAddress(stripAngles(rep.report?.originalMailFrom));
    if (fromDomain) wanted.add(fromDomain);
  }
  const resolution = new Map<string, string>();
  if (wanted.size > 0) {
    const rows = await db
      .select({ domainName: domains.domainName, tenantId: emailDomains.tenantId })
      .from(emailDomains)
      .innerJoin(domains, eq(emailDomains.domainId, domains.id))
      .where(inArray(sql`LOWER(${domains.domainName})`, [...wanted]));
    for (const row of rows) resolution.set(row.domainName.toLowerCase(), row.tenantId);
  }

  let stored = 0;
  const consumed: string[] = [];
  for (const rep of reports) {
    const row = mapArfReport(rep, (d) => resolution.get(d));
    try {
      const inserted = await db
        .insert(emailFblComplaints)
        .values(row)
        .onConflictDoNothing({ target: emailFblComplaints.stalwartReportId })
        .returning({ id: emailFblComplaints.id });
      if (inserted.length > 0) stored += 1;
      consumed.push(rep.id);
    } catch (err) {
      // Leave the report in Stalwart — the next poll retries it.
      logger.error({ err, reportId: rep.id }, 'fbl poll: failed to persist complaint');
    }
  }

  let destroyed = 0;
  if (consumed.length > 0) {
    try {
      const res = await arfExternalReportDestroy({ ids: consumed, ...opts });
      destroyed = res.destroyed?.length ?? 0;
      const failed = Object.keys(res.notDestroyed ?? {});
      if (failed.length > 0) {
        // HA: a sibling replica may have destroyed them first
        // (notFound) — harmless; anything else still re-reads next
        // poll thanks to the idempotent insert.
        logger.warn({ notDestroyed: res.notDestroyed }, 'fbl poll: some reports not destroyed (will dedupe next poll)');
      }
    } catch (err) {
      // Persisted rows are idempotent on stalwart_report_id, so a
      // failed destroy only means re-reading them next poll.
      logger.warn({ err }, 'fbl poll: destroy of consumed reports failed (will dedupe next poll)');
    }
  }

  logger.info({ fetched: reports.length, stored, destroyed }, 'fbl poll: complaints ingested');
  return { skipped: false, fetched: reports.length, stored, destroyed };
}

// ── Debounced immediate poll ───────────────────────────────────────────────
// The webhook ingest calls this when an incoming-report.* event lands
// so complaints surface within seconds instead of the 5-min tick.

let pollTimer: NodeJS.Timeout | null = null;

export function schedulePollSoon(
  db: Database,
  logger: OutboundReconcileLogger,
  delayMs = 5_000,
): void {
  if (pollTimer) return; // already scheduled
  pollTimer = setTimeout(() => {
    pollTimer = null;
    pollFblComplaints(db, logger).catch((err) => {
      logger.warn({ err }, 'fbl poll (webhook-triggered) failed');
    });
  }, delayMs);
  pollTimer.unref();
}

/** Test hook. */
export function cancelScheduledPoll(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

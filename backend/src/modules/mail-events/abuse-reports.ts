/**
 * ARF abuse-report ingestion (RFC 5965).
 *
 * Stalwart parses the `message/feedback-report` part of a complaint that
 * arrives at a ReportSettings intake address and stores a typed
 * `x:ArfExternalReport` object. This module polls those, attributes each to a
 * tenant, persists it, tells the admin roster, and destroys what it consumed.
 *
 * Why this exists when FBL was retired
 * ------------------------------------
 * FBL was about a complaint RATE — a deliverability metric that needs
 * per-provider enrolment (Microsoft JMRP/SNDS, Yahoo CFL) with production IPs
 * before a single row can exist, and none ever did. An abuse report is the
 * other half of the same format: one operator telling us that mail from one of
 * our tenants is a problem. It arrives unsolicited, it is rare, and one of
 * them is worth waking somebody for. There is no denominator here and no
 * threshold evaluator — the unit is an incident, not a rate.
 *
 * Why a poll and not the webhook payload
 * ----------------------------------------
 * The `incoming-report.*` webhook event carries only the domain, not the
 * report, and does not say which report type landed. It is a NUDGE: the
 * webhook route schedules this poll so a complaint surfaces in seconds rather
 * than on the next 5-minute tick. The poll is the source of truth, so a missed
 * or unsubscribed webhook delays ingestion but never loses a report.
 *
 * Ordering
 * --------
 * Persist, then notify, then destroy — in that order, per report. Destroying
 * first would lose the complaint if the insert failed; notifying before the
 * insert would announce something with no row behind it. `stalwart_report_id`
 * is UNIQUE, so the redelivery that a mid-poll crash produces is absorbed
 * rather than duplicated.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, desc, sql } from 'drizzle-orm';
import { emailAbuseReports, emailDomains, domains } from '../../db/schema.js';
import {
  arfExternalReportList,
  arfExternalReportDestroy,
  type StalwartArfReportRow,
} from '../stalwart-jmap/client.js';
import { notifyAdminOperationalEvent } from '../notifications/events.js';
import type { Database } from '../../db/index.js';
import type { OutboundReconcileLogger } from '../email-outbound/service.js';

/**
 * Feedback types worth a row and an alert.
 *
 * `not-spam` (RFC 6430) is the inverse signal and `auth-failure` (RFC 6591) is
 * a DMARC forensic report — the platform keeps `ruf=` reporting off in both
 * directions, and an inbound one is not an abuse complaint. Neither is an
 * incident, so neither is stored here. Stalwart still parses them; they are
 * simply consumed and dropped, which is why the poll destroys every id it
 * fetched rather than only the ones it stored.
 */
const ACTIONABLE_FEEDBACK_TYPES = new Set(['abuse', 'fraud', 'virus']);

/** Anything Stalwart could not classify still counts as an incident. */
const DEFAULT_FEEDBACK_TYPE = 'other';

export interface AbuseReportPollResult {
  readonly fetched: number;
  readonly stored: number;
  readonly notified: number;
  readonly destroyed: number;
  readonly skipped: number;
}

const EMPTY: AbuseReportPollResult = {
  fetched: 0, stored: 0, notified: 0, destroyed: 0, skipped: 0,
};

/** Object-keyed-by-value → a plain list. Stalwart never sends these as arrays. */
function keysOf(value: Record<string, boolean> | undefined | null): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.keys(value).filter((k) => value[k]);
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Trim to a column width without throwing on a null. */
/**
 * Strip the angle brackets an ARF address carries.
 *
 * RFC 5965 gives `Original-Mail-From` and `Original-Rcpt-To` as RFC 5322
 * angle-addr, so Stalwart hands them over as `<user@example.test>`. Stored raw
 * they reach the panels and the admin notification verbatim, which is how
 * `<newsletter@example.test>` ended up in operator-facing copy. The brackets
 * are syntax, not part of the address.
 */
function unbracket(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t) return null;
  return t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1).trim() || null : t;
}

function cap(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

export interface AttributedReport {
  readonly domain: string | null;
  readonly tenantId: string | null;
}

/**
 * Which tenant is this complaint about?
 *
 * The reported domain is the strongest signal, but a complaint that names a
 * domain we do not host still gets a row: an unattributed complaint is
 * evidence too, and dropping it would make the abuse desk look quiet. So the
 * lookup narrows attribution, it never filters.
 */
export async function attributeReport(
  db: Database,
  report: StalwartArfReportRow,
): Promise<AttributedReport> {
  const candidates = [
    ...keysOf(report.report?.reportedDomains),
    // `originalMailFrom` is the envelope sender of the offending message, so
    // its domain is ours when the complaint is about a tenant's outbound mail.
    ...(report.report?.originalMailFrom?.includes('@')
      ? [report.report.originalMailFrom.split('@').pop() as string]
      : []),
  ]
    .map((d) => d.trim().toLowerCase().replace(/\.+$/, ''))
    .filter(Boolean);

  if (candidates.length === 0) return { domain: null, tenantId: null };

  const rows = await db
    .select({ tenantId: emailDomains.tenantId, domainName: domains.domainName })
    .from(emailDomains)
    .innerJoin(domains, eq(emailDomains.domainId, domains.id))
    .where(inArray(sql`lower(${domains.domainName})`, candidates));

  for (const candidate of candidates) {
    const hit = rows.find((r) => r.domainName.toLowerCase() === candidate);
    if (hit) return { domain: candidate, tenantId: hit.tenantId };
  }
  // Named a domain, but not one of ours. Keep the name — it is the only clue
  // the operator has about what the complaint is actually about.
  return { domain: candidates[0] ?? null, tenantId: null };
}

/**
 * Tell the admin roster. One notification per report, deduped on the Stalwart
 * object id so a retried poll cannot announce the same complaint twice.
 *
 * Deliberately per-report rather than batched: abuse complaints are rare and
 * individually actionable, and a digest would bury the one line that says
 * which tenant. If that ever changes, the fix is a digest — not a threshold,
 * which would silently drop the first complaints.
 */
async function announce(
  db: Database,
  row: {
    id: string;
    stalwartReportId: string;
    domain: string | null;
    tenantId: string | null;
    feedbackType: string;
    originalMailFrom: string | null;
    sourceIp: string | null;
    reporter: string | null;
    incidents: number;
  },
): Promise<void> {
  const subject = row.domain ?? 'an unattributed domain';
  const about = row.originalMailFrom ? ` about mail from ${row.originalMailFrom}` : '';
  const from = row.reporter ? ` Reported by ${row.reporter}.` : '';
  const ip = row.sourceIp ? ` Source IP ${row.sourceIp}.` : '';
  const many = row.incidents > 1 ? ` The report covers ${row.incidents} incidents.` : '';

  // "An abuse report", not "A abuse report". The feedback type is interpolated
  // straight into operator-facing copy, and `abuse` is the commonest one.
  const article = /^[aeiou]/i.test(row.feedbackType) ? 'An' : 'A';

  await notifyAdminOperationalEvent(db, 'mail', {
    subsystem: 'Abuse reports',
    objectLabel: subject,
    detail:
      `${article} ${row.feedbackType} report was received for ${subject}${about}.${from}${ip}${many}`,
    severityLabel: row.feedbackType === 'abuse' ? 'abuse complaint' : `${row.feedbackType} report`,
    recommendedAction: row.tenantId
      ? 'Review the tenant’s outbound mail under Monitoring → Mail, and suspend outbound if the complaint is substantiated.'
      : 'Review Monitoring → Mail. The reported domain is not an email domain on this platform, so the complaint may be about a spoof of it.',
  }, `abuse-report:${row.stalwartReportId}`);
}

/**
 * Poll, persist, announce, destroy.
 *
 * Never throws: it runs on the mail self-heal tick, where one failing
 * reconciler must not stop the others.
 */
export async function pollAbuseReports(
  db: Database,
  logger: OutboundReconcileLogger,
  opts: { baseUrl?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<AbuseReportPollResult> {
  let reports: readonly StalwartArfReportRow[];
  try {
    reports = await arfExternalReportList(opts);
  } catch (err) {
    logger.warn({ err }, 'abuse reports: Stalwart JMAP unreachable, skipped');
    return EMPTY;
  }
  if (reports.length === 0) return EMPTY;

  let stored = 0;
  let notified = 0;
  let skipped = 0;
  // Every id fetched is destroyed, including the ones deliberately not stored
  // — leaving those behind would make each poll refetch them forever.
  const consumed: string[] = [];

  for (const report of reports) {
    const feedbackType = cap(report.report?.feedbackType, 32)?.toLowerCase() ?? DEFAULT_FEEDBACK_TYPE;
    if (!ACTIONABLE_FEEDBACK_TYPES.has(feedbackType) && feedbackType !== DEFAULT_FEEDBACK_TYPE) {
      skipped += 1;
      consumed.push(report.id);
      continue;
    }

    try {
      const { domain, tenantId } = await attributeReport(db, report);
      const receivedAt = parseDate(report.receivedAt)
        ?? parseDate(report.report?.arrivalDate)
        ?? new Date();
      const row = {
        id: randomUUID(),
        stalwartReportId: report.id,
        tenantId,
        domain: cap(domain, 255),
        feedbackType,
        originalMailFrom: cap(unbracket(report.report?.originalMailFrom), 320),
        originalRcptTo: cap(unbracket(report.report?.originalRcptTo), 320),
        sourceIp: cap(report.report?.sourceIp, 64),
        reportingMta: cap(report.report?.reportingMta, 255),
        reporter: cap(unbracket(report.from), 320),
        subject: cap(report.subject, 2000),
        incidents: Math.max(1, Math.trunc(report.report?.incidents ?? 1)),
        receivedAt,
        raw: report as unknown as Record<string, unknown>,
      };

      // DO NOTHING on conflict: a redelivery after a mid-poll crash is the
      // expected path, not an error, and must not reset `notified_at`.
      const inserted = await db
        .insert(emailAbuseReports)
        .values(row)
        .onConflictDoNothing({ target: emailAbuseReports.stalwartReportId })
        .returning({ id: emailAbuseReports.id });

      if (inserted.length > 0) stored += 1;
      consumed.push(report.id);
      logger.info(
        {
          reportId: report.id,
          feedbackType,
          domain: row.domain,
          tenantId,
          incidents: row.incidents,
          duplicate: inserted.length === 0,
        },
        'abuse reports: ingested an ARF report',
      );
    } catch (err) {
      // Leave it in Stalwart — the next poll retries it. NOT added to
      // `consumed`, or the complaint would be destroyed unstored.
      logger.error({ err, reportId: report.id }, 'abuse reports: failed to persist a report');
    }
  }

  // Announce from the TABLE, not from this batch: a notification that failed
  // on a previous tick is retried here, and one that already went out is not
  // repeated. `notified_at` is the record of what the operator has seen.
  try {
    notified = await announceUnnotified(db, logger);
  } catch (err) {
    logger.error({ err }, 'abuse reports: announcing failed (retries next tick)');
  }

  let destroyed = 0;
  if (consumed.length > 0) {
    try {
      const res = await arfExternalReportDestroy({ ids: consumed, ...opts });
      destroyed = consumed.length - Object.keys(res.notDestroyed ?? {}).length;
      if (res.notDestroyed && Object.keys(res.notDestroyed).length > 0) {
        logger.warn({ notDestroyed: res.notDestroyed }, 'abuse reports: some reports not destroyed (will dedupe next poll)');
      }
    } catch (err) {
      logger.warn({ err }, 'abuse reports: destroy of consumed reports failed (will dedupe next poll)');
    }
  }

  logger.info({ fetched: reports.length, stored, notified, destroyed, skipped }, 'abuse reports: poll complete');
  return { fetched: reports.length, stored, notified, destroyed, skipped };
}

/**
 * Announce every stored report the roster has not been told about yet.
 *
 * Separate from the ingest loop so a notification outage is recoverable: the
 * rows persist with `notified_at IS NULL` and the next tick picks them up.
 * Exported for unit coverage.
 */
export async function announceUnnotified(
  db: Database,
  logger: OutboundReconcileLogger,
): Promise<number> {
  const pending = await db
    .select({
      id: emailAbuseReports.id,
      stalwartReportId: emailAbuseReports.stalwartReportId,
      domain: emailAbuseReports.domain,
      tenantId: emailAbuseReports.tenantId,
      feedbackType: emailAbuseReports.feedbackType,
      originalMailFrom: emailAbuseReports.originalMailFrom,
      sourceIp: emailAbuseReports.sourceIp,
      reporter: emailAbuseReports.reporter,
      incidents: emailAbuseReports.incidents,
    })
    .from(emailAbuseReports)
    .where(isNull(emailAbuseReports.notifiedAt))
    .orderBy(desc(emailAbuseReports.receivedAt))
    .limit(50);

  let sent = 0;
  for (const row of pending) {
    try {
      await announce(db, row);
      // Stamped only after the dispatch resolves. Stamping first would lose
      // the complaint on a transient notification failure — the row would
      // look announced forever.
      await db
        .update(emailAbuseReports)
        .set({ notifiedAt: new Date() })
        .where(and(
          eq(emailAbuseReports.id, row.id),
          isNull(emailAbuseReports.notifiedAt),
        ));
      sent += 1;
    } catch (err) {
      logger.error(
        { err, reportId: row.stalwartReportId },
        'abuse reports: could not notify admins (retries next tick)',
      );
    }
  }
  return sent;
}

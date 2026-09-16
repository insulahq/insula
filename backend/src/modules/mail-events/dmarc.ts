/**
 * DMARC aggregate-report ingestion (ROADMAP R5).
 *
 * Mirrors `fbl.ts`. Stalwart's report-analysis intercepts mail to the
 * configured report addresses, un-gzips the attachment, parses the RFC 7489
 * aggregate XML and stores a typed `x:DmarcExternalReport` registry object —
 * the platform never sees the XML. This module polls those objects, attributes
 * each to a tenant by its policy domain, persists a summary plus one row per
 * reported source IP, and destroys the consumed object.
 *
 * ## Shape details taken from the wire, not from the RFC
 *
 * Verified 2026-09-13 by delivering a real aggregate report to a live server
 * and reading the stored object back:
 *
 *   - `records`, `dkimResults` and `spfResults` are **objects keyed by
 *     decimal-string index** (`{"0": …, "1": …}`), not arrays. Treating them as
 *     arrays yields zero records and reports a domain with real traffic as
 *     having sent nothing — a silent zero, not an error.
 *   - Result values are **camelCase**: SPF softfail arrives as `softFail`, not
 *     the RFC's `softfail`. Everything here lowercases before comparing.
 *
 * ## What "pass" means
 *
 * DMARC passes when EITHER SPF or DKIM passes *and* aligns with the header
 * From domain. `evaluatedDkim` / `evaluatedSpf` in the report are the
 * reporter's already-alignment-aware verdicts, so this does not re-implement
 * alignment — it reads the verdict the reporter reached.
 *
 * Attribution is by `policyDomain`. A report for a domain this platform does
 * not host is still stored with a null tenant: it is evidence about the
 * platform's sending reputation, and dropping it would make the
 * "unattributed" case indistinguishable from "no reports arrived".
 */

import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  domains,
  emailDomains,
  emailDmarcReports,
  emailDmarcSources,
} from '../../db/schema.js';
import {
  dmarcExternalReportList,
  dmarcExternalReportDestroy,
  type StalwartDmarcRecord,
  type StalwartDmarcReportRow,
} from '../stalwart-jmap/client.js';
import type { Database } from '../../db/index.js';
import type { OutboundReconcileLogger } from '../email-outbound/service.js';

/**
 * Walk a Stalwart index-keyed collection.
 *
 * The single most load-bearing helper in this file. `records` looks like an
 * array in every example of the RFC and is an object on the wire; a `.map()`
 * over it throws, and an `Array.isArray()` guard around it silently yields
 * nothing. Accepting both shapes means a future Stalwart release that switches
 * to real arrays does not quietly start reporting zero messages.
 */
export function indexedValues<T>(v: Record<string, T> | readonly T[] | null | undefined): T[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return [...v];
  return Object.values(v as Record<string, T>);
}

/** Normalise a reporter verdict for comparison (`softFail` → `softfail`). */
function verdict(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  return t.length > 0 ? t : null;
}

function parseDate(v: string | null | undefined): Date | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A whole-number message count; anything else contributes 0 rather than NaN. */
function count(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export interface DmarcSourceRow {
  readonly id: string;
  readonly reportId: string;
  readonly tenantId: string | null;
  readonly policyDomain: string | null;
  readonly sourceIp: string | null;
  readonly messageCount: number;
  readonly evaluatedDkim: string | null;
  readonly evaluatedSpf: string | null;
  readonly disposition: string | null;
  readonly headerFrom: string | null;
  readonly receivedAt: Date;
}

export interface DmarcReportRow {
  readonly id: string;
  readonly stalwartReportId: string;
  readonly tenantId: string | null;
  readonly emailDomainId: string | null;
  readonly policyDomain: string | null;
  readonly orgName: string | null;
  readonly reporterEmail: string | null;
  readonly reportId: string | null;
  readonly dateRangeBegin: Date | null;
  readonly dateRangeEnd: Date | null;
  readonly policyDisposition: string | null;
  readonly policyAdkim: string | null;
  readonly policyAspf: string | null;
  readonly totalMessages: number;
  readonly passMessages: number;
  readonly failMessages: number;
  readonly dkimPassMessages: number;
  readonly spfPassMessages: number;
  readonly quarantinedMessages: number;
  readonly rejectedMessages: number;
  readonly receivedAt: Date;
  readonly raw: Record<string, unknown>;
}

/** Summary + per-source rows produced from one Stalwart report object. */
export interface MappedDmarcReport {
  readonly report: DmarcReportRow;
  readonly sources: readonly DmarcSourceRow[];
}

/**
 * Pure: one Stalwart report object → the rows to persist.
 *
 * `resolve` maps a lowercased domain name to its tenant + email-domain ids;
 * a miss leaves both null and the report is still stored.
 */
export function mapDmarcReport(
  row: StalwartDmarcReportRow,
  resolve: (domain: string) => { tenantId: string; emailDomainId: string } | undefined,
  now: Date = new Date(),
): MappedDmarcReport {
  const rep = row.report ?? {};
  const policyDomain = typeof rep.policyDomain === 'string' && rep.policyDomain.length > 0
    ? rep.policyDomain.toLowerCase()
    : null;
  const owner = policyDomain ? resolve(policyDomain) : undefined;
  const receivedAt = parseDate(row.receivedAt) ?? now;
  const reportUuid = randomUUID();

  const records = indexedValues<StalwartDmarcRecord>(rep.records);

  let total = 0;
  let pass = 0;
  let fail = 0;
  let dkimPass = 0;
  let spfPass = 0;
  let quarantined = 0;
  let rejected = 0;
  const sources: DmarcSourceRow[] = [];

  for (const r of records) {
    const n = count(r.count);
    const dkim = verdict(r.evaluatedDkim);
    const spf = verdict(r.evaluatedSpf);
    const disposition = verdict(r.evaluatedDisposition);

    total += n;
    if (dkim === 'pass') dkimPass += n;
    if (spf === 'pass') spfPass += n;
    // DMARC passes on EITHER aligned mechanism — not both.
    if (dkim === 'pass' || spf === 'pass') pass += n; else fail += n;
    if (disposition === 'quarantine') quarantined += n;
    if (disposition === 'reject') rejected += n;

    sources.push({
      id: randomUUID(),
      reportId: reportUuid,
      tenantId: owner?.tenantId ?? null,
      policyDomain,
      sourceIp: typeof r.sourceIp === 'string' && r.sourceIp.length > 0 ? r.sourceIp.slice(0, 64) : null,
      messageCount: n,
      evaluatedDkim: dkim,
      evaluatedSpf: spf,
      disposition,
      headerFrom: typeof r.headerFrom === 'string' && r.headerFrom.length > 0
        ? r.headerFrom.toLowerCase().slice(0, 255)
        : null,
      receivedAt,
    });
  }

  return {
    report: {
      id: reportUuid,
      stalwartReportId: row.id,
      tenantId: owner?.tenantId ?? null,
      emailDomainId: owner?.emailDomainId ?? null,
      policyDomain,
      orgName: typeof rep.orgName === 'string' ? rep.orgName.slice(0, 255) : null,
      reporterEmail: typeof rep.email === 'string' ? rep.email.slice(0, 320) : null,
      reportId: typeof rep.reportId === 'string' ? rep.reportId.slice(0, 255) : null,
      dateRangeBegin: parseDate(rep.dateRangeBegin),
      dateRangeEnd: parseDate(rep.dateRangeEnd),
      policyDisposition: verdict(rep.policyDisposition),
      policyAdkim: verdict(rep.policyAdkim),
      policyAspf: verdict(rep.policyAspf),
      totalMessages: total,
      passMessages: pass,
      failMessages: fail,
      dkimPassMessages: dkimPass,
      spfPassMessages: spfPass,
      quarantinedMessages: quarantined,
      rejectedMessages: rejected,
      receivedAt,
      raw: (row as unknown as Record<string, unknown>),
    },
    sources,
  };
}

export interface DmarcPollResult {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly fetched: number;
  readonly stored: number;
  readonly sourcesStored: number;
  readonly destroyed: number;
}

/**
 * Poll, persist, destroy.
 *
 * At-least-once by construction: the insert is idempotent on
 * `stalwartReportId`, so a destroy that fails only means re-reading the object
 * on the next tick. That ordering — persist, then destroy — is the one that
 * cannot lose a report.
 */
export async function pollDmarcReports(
  db: Database,
  logger: OutboundReconcileLogger,
  opts: { baseUrl?: string; env?: NodeJS.ProcessEnv; now?: () => Date } = {},
): Promise<DmarcPollResult> {
  const now = opts.now ?? (() => new Date());
  let reports: readonly StalwartDmarcReportRow[];
  try {
    reports = await dmarcExternalReportList(opts);
  } catch (err) {
    logger.warn({ err }, 'dmarc poll: Stalwart JMAP unreachable, skipped');
    return { skipped: true, reason: 'stalwart unreachable', fetched: 0, stored: 0, sourcesStored: 0, destroyed: 0 };
  }
  if (reports.length === 0) {
    return { skipped: false, fetched: 0, stored: 0, sourcesStored: 0, destroyed: 0 };
  }

  // Resolve every policy domain in one query rather than per report.
  const wanted = new Set<string>();
  for (const rep of reports) {
    const d = rep.report?.policyDomain;
    if (typeof d === 'string' && d.length > 0) wanted.add(d.toLowerCase());
  }
  const resolution = new Map<string, { tenantId: string; emailDomainId: string }>();
  if (wanted.size > 0) {
    const rows = await db
      .select({
        domainName: domains.domainName,
        tenantId: emailDomains.tenantId,
        emailDomainId: emailDomains.id,
      })
      .from(emailDomains)
      .innerJoin(domains, eq(emailDomains.domainId, domains.id))
      .where(inArray(sql`LOWER(${domains.domainName})`, [...wanted]));
    for (const row of rows) {
      resolution.set(row.domainName.toLowerCase(), {
        tenantId: row.tenantId,
        emailDomainId: row.emailDomainId,
      });
    }
  }

  let stored = 0;
  let sourcesStored = 0;
  const consumed: string[] = [];

  for (const rep of reports) {
    const mapped = mapDmarcReport(rep, (d) => resolution.get(d), now());
    try {
      const inserted = await db
        .insert(emailDmarcReports)
        .values(mapped.report)
        .onConflictDoNothing({ target: emailDmarcReports.stalwartReportId })
        .returning({ id: emailDmarcReports.id });

      if (inserted.length > 0) {
        stored += 1;
        if (mapped.sources.length > 0) {
          // Chunked: an aggregate report from a large mailbox provider can
          // carry thousands of source rows, and one oversized parameterised
          // INSERT hits the Postgres bind-parameter ceiling — which would fail
          // the whole report rather than degrade.
          const CHUNK = 500;
          for (let i = 0; i < mapped.sources.length; i += CHUNK) {
            const slice = mapped.sources.slice(i, i + CHUNK);
            await db.insert(emailDmarcSources).values(slice);
            sourcesStored += slice.length;
          }
        }
      }
      // Consume on a duplicate too: the object is already represented.
      consumed.push(rep.id);
    } catch (err) {
      // Leave it in Stalwart — the next poll retries it.
      logger.error({ err, reportId: rep.id }, 'dmarc poll: failed to persist report');
    }
  }

  let destroyed = 0;
  if (consumed.length > 0) {
    try {
      const res = await dmarcExternalReportDestroy({ ids: consumed, ...opts });
      destroyed = res.destroyed?.length ?? 0;
      const failed = Object.keys(res.notDestroyed ?? {});
      if (failed.length > 0) {
        logger.warn({ notDestroyed: res.notDestroyed }, 'dmarc poll: some reports not destroyed (will dedupe next poll)');
      }
    } catch (err) {
      logger.warn({ err }, 'dmarc poll: destroy of consumed reports failed (will dedupe next poll)');
    }
  }

  logger.info({ fetched: reports.length, stored, sourcesStored, destroyed }, 'dmarc poll: aggregate reports ingested');
  return { skipped: false, fetched: reports.length, stored, sourcesStored, destroyed };
}

// ── Debounced immediate poll ───────────────────────────────────────────────
// The webhook ingest calls this when an incoming-report.* event lands so a
// report surfaces within seconds instead of waiting for the 5-min tick.
//
// Moved here from fbl.ts when FBL was retired (2026-09-15). It had always
// driven BOTH pollers — an incoming-report.* event does not say which report
// type arrived — so deleting it with the FBL module would have silently cost
// DMARC its fast path and left only the 5-minute tick.

let pollTimer: NodeJS.Timeout | null = null;

export function schedulePollSoon(
  db: Database,
  logger: OutboundReconcileLogger,
  delayMs = 5_000,
): void {
  if (pollTimer) return; // already scheduled
  pollTimer = setTimeout(() => {
    pollTimer = null;
    pollDmarcReports(db, logger).catch((err) => {
      logger.warn({ err }, 'dmarc poll (webhook-triggered) failed');
    });
  }, delayMs);
  pollTimer.unref();
}

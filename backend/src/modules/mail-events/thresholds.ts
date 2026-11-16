/**
 * Outbound-mail threshold evaluator.
 *
 * Runs on the 5-min mail tick. Two checks, both governed by the
 * `mail_enforcement_mode` platform setting (the admin control surface
 * in Mail Settings → Sending Protection):
 *
 *   off    — evaluator disabled entirely.
 *   notify — (DEFAULT) notifications only; admins act via the existing
 *            levers (per-tenant limits / outbound suspension).
 *
 * Quota usage (80%/100% of hour/day windows) notifies the TENANT; send-limit
 * saturation notifies the OPERATOR. Neither takes automatic action — Stalwart
 * already enforces the limit itself.
 *
 * ## `auto` was removed with FBL
 *
 * The mode existed solely to act on FBL complaint rates: `mode === 'auto'`
 * appeared exactly once in this file, inside the complaint evaluator. With FBL
 * retired it would have been a setting that promises automatic enforcement and
 * silently does nothing — the stored-and-ignored class this codebase has spent
 * real effort deleting. Existing `auto` values migrate to `notify`, which is
 * what `auto` would now do anyway.
 *
 * Both work PER MAIL DOMAIN, the unit Stalwart enforces the limits on: a
 * tenant whose two domains sent 60 each has used 60% of each domain's 100, not
 * 120% of anything, and nothing was held.
 *
 * Dedupe:
 *   - quota: PK insert on (tenant, domain, window, threshold, window_start) —
 *     each domain fires each threshold at most once per calendar window.
 */

import { and, eq, gte, lt, sql, inArray, like } from 'drizzle-orm';
import {
  tenants,
  hostingPlans,
  emailSendCounters,
  emailSenderCounters,
  emailQuotaEvents,
  emailDomains,
  domains,
  platformSettings,
} from '../../db/schema.js';
import { buildEffectiveSendLimits } from '../email-outbound/rate-limit.js';
import { readDomainUsage, windowStarts } from './domain-usage.js';
import type { Database } from '../../db/index.js';
import type { OutboundReconcileLogger } from '../email-outbound/service.js';

export type MailEnforcementMode = 'off' | 'notify';

export const QUOTA_THRESHOLDS = [80, 100] as const;
const QUOTA_EVENT_RETENTION_DAYS = 7;
/**
 * Send-limit-saturation admin alert (workstream A). Combined rate-limited
 * + quota-rejected outbound in the CURRENT hour bucket, per (tenant,
 * domain). Warning surfaces a runaway/abusive sender to the operator;
 * critical is compromise territory. Both configurable via platform_settings
 * (`mail_abuse_warn_threshold` / `mail_abuse_critical_threshold`).
 */
export const ABUSE_WARN_DEFAULT = 50;
export const ABUSE_CRITICAL_DEFAULT = 500;

export async function getMailEnforcementMode(db: Database): Promise<MailEnforcementMode> {
  const [row] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, 'mail_enforcement_mode'));
  const v = row?.value;
  // 'auto' is retired; any stored value other than 'off' means notify.
  return v === 'off' ? 'off' : 'notify';
}

// ── Quota usage ─────────────────────────────────────────────────────────────

/** One (tenant, sending domain)'s current hour and UTC day. */
export interface DomainUsageRow {
  readonly tenantId: string;
  readonly domain: string;
  readonly hourSent: number;
  readonly daySent: number;
}

export interface QuotaCrossing {
  readonly tenantId: string;
  readonly domain: string;
  readonly window: 'hour' | 'day';
  readonly threshold: 80 | 100;
  readonly used: number;
  readonly limit: number;
}

/**
 * Pure: per-domain usage rows + per-tenant limits -> threshold crossings.
 * The limits are per domain, so each row is held to them on its own.
 * A 100% crossing implies the 80% one; both rows are recorded but the
 * tenant is only notified at the HIGHEST new crossing per domain and window.
 */
export function computeQuotaCrossings(
  usage: readonly DomainUsageRow[],
  limits: ReadonlyMap<string, { hourly: number; daily: number }>,
): QuotaCrossing[] {
  const crossings: QuotaCrossing[] = [];
  for (const u of usage) {
    const l = limits.get(u.tenantId);
    if (!l) continue;
    for (const [window, used, limit] of [
      ['hour', u.hourSent, l.hourly],
      ['day', u.daySent, l.daily],
    ] as const) {
      if (limit <= 0) continue; // blocked/suspended — no usage warnings
      for (const threshold of QUOTA_THRESHOLDS) {
        if ((used / limit) * 100 >= threshold) {
          crossings.push({ tenantId: u.tenantId, domain: u.domain, window, threshold, used, limit });
        }
      }
    }
  }
  return crossings;
}


/**
 * The accounts that actually sent, for the window that tripped.
 *
 * "Your tenant sent 53 of 50" tells an operator nothing they can act on when
 * the tenant has ten mailboxes. "notifications@example.test (48),
 * sales@example.test (5)" tells them whether this is a compromised account, a
 * runaway integration, or normal business growth — which are three completely
 * different responses.
 */
async function topSendersFor(
  db: Database,
  tenantId: string,
  domain: string,
  window: 'hour' | 'day',
  now: Date,
): Promise<string[] | null> {
  const { hourStart, dayStart } = windowStarts(now);
  const since = window === 'hour' ? hourStart : dayStart;
  // The domain's own accounts: another domain's senders did not use its limit.
  const domainPattern = `%@${domain.replace(/[\\%_]/g, (c) => `\\${c}`)}`;
  try {
    const rows = await db
      .select({
        sender: emailSenderCounters.sender,
        sent: sql<number>`COALESCE(SUM(${emailSenderCounters.sentCount}), 0)`,
      })
      .from(emailSenderCounters)
      .where(and(
        eq(emailSenderCounters.tenantId, tenantId),
        gte(emailSenderCounters.bucketStart, since),
        like(emailSenderCounters.sender, domainPattern),
      ))
      .groupBy(emailSenderCounters.sender)
      .orderBy(sql`2 DESC`)
      .limit(5);
    if (rows.length === 0) return null;
    return rows.map((r) => `${r.sender} (${r.sent} sent)`);
  } catch {
    // An attribution we cannot read must not stop the alert that needs it.
    return null;
  }
}

/** lower(domain) → email_domains.id per tenant, for the tenant notification's Statistics link. */
async function emailDomainIdsFor(db: Database, tenantIds: readonly string[]): Promise<Map<string, string>> {
  if (tenantIds.length === 0) return new Map();
  const rows = await db
    .select({ tenantId: emailDomains.tenantId, id: emailDomains.id, domain: domains.domainName })
    .from(emailDomains)
    .innerJoin(domains, eq(domains.id, emailDomains.domainId))
    .where(inArray(emailDomains.tenantId, [...tenantIds]));
  return new Map(rows.map((r) => [`${r.tenantId}|${r.domain.toLowerCase()}`, r.id]));
}

async function evaluateQuotaUsage(db: Database, logger: OutboundReconcileLogger, now: Date): Promise<number> {
  const usage: DomainUsageRow[] = (await readDomainUsage(db, { now })).map((u) => ({
    tenantId: u.tenantId,
    domain: u.domain,
    hourSent: u.sentThisHour,
    daySent: u.sentToday,
  }));

  if (usage.length === 0) return 0;
  const { hourStart, dayStart } = windowStarts(now);

  const limitRows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      status: tenants.status,
      planId: tenants.planId,
      emailSendRateLimit: tenants.emailSendRateLimit,
      emailSendRateLimitDaily: tenants.emailSendRateLimitDaily,
      emailOutboundSuspended: tenants.emailOutboundSuspended,
      planCode: hostingPlans.code,
      planHourly: hostingPlans.emailHourlySendLimit,
      planDaily: hostingPlans.emailDailySendLimit,
    })
    .from(tenants)
    .leftJoin(hostingPlans, eq(tenants.planId, hostingPlans.id));
  const limits = new Map(limitRows.map((r) => {
    const resolved = buildEffectiveSendLimits(r);
    return [r.id, { hourly: resolved.hourly.limit, daily: resolved.daily.limit }];
  }));
  // The alert used to read "3fd54013-fc40-4e13-adaf-ed1b5dd39f28 saturated its
  // hour sending limit" because this loop had the id and never asked for the
  // name. The dispatcher now resolves ids as a backstop; passing the name is
  // still the emitter's job.
  const tenantNames = new Map(limitRows.map((r) => [r.id, r.name]));

  const crossings = computeQuotaCrossings(usage, limits);
  let notified = 0;

  const emailDomainIds = await emailDomainIdsFor(db, [...new Set(crossings.map((c) => c.tenantId))]);

  // Group by tenant+domain+window so only the highest NEW threshold notifies.
  const byDomainWindow = new Map<string, QuotaCrossing[]>();
  for (const c of crossings) {
    const key = `${c.tenantId}|${c.domain}|${c.window}`;
    byDomainWindow.set(key, [...(byDomainWindow.get(key) ?? []), c]);
  }

  for (const group of byDomainWindow.values()) {
    const sorted = [...group].sort((a, b) => b.threshold - a.threshold);
    let highestNew: QuotaCrossing | null = null;
    for (const c of sorted) {
      // The window start is the UTC hour or day the counts were read for —
      // computed once per pass, so every replica keys the same window.
      const inserted = await db
        .insert(emailQuotaEvents)
        .values({
          tenantId: c.tenantId,
          domain: c.domain,
          windowKind: c.window,
          threshold: c.threshold,
          windowStart: c.window === 'hour' ? hourStart : dayStart,
        })
        .onConflictDoNothing()
        .returning({ threshold: emailQuotaEvents.threshold });
      if (inserted.length > 0 && !highestNew) highestNew = c;
    }

    if (highestNew) {
      try {
        const { notifyTenantEmailQuotaWarning, notifyTenantEmailQuotaExceeded } = await import('../notifications/events.js');
        const senders = await topSendersFor(db, highestNew.tenantId, highestNew.domain, highestNew.window, now);
        const payload = {
          domain: highestNew.domain,
          window: highestNew.window,
          percent: String(Math.floor((highestNew.used / highestNew.limit) * 100)),
          used: String(highestNew.used),
          limit: String(highestNew.limit),
          releasesAt: releaseTime(highestNew.window, now),
          topSenders: senders ?? ['no per-sender attribution recorded yet'],
        };
        const emailDomainId = emailDomainIds.get(`${highestNew.tenantId}|${highestNew.domain}`) ?? null;
        if (highestNew.threshold >= 100) {
          await notifyTenantEmailQuotaExceeded(db, highestNew.tenantId, payload, emailDomainId);
          // The operator too, at 100% only. A tenant saturating the sending
          // limit is the shape of both a compromised account and a
          // platform-wide deliverability risk — and until now this event had
          // exactly one audience, so nobody on the platform side ever heard.
          const { notifyAdminEmailQuotaExceeded } = await import('../notifications/events.js');
          await notifyAdminEmailQuotaExceeded(db, {
            tenantLabel: tenantNames.get(highestNew.tenantId) ?? highestNew.tenantId,
            domain: highestNew.domain,
            topSenders: payload.topSenders,
            releasesAt: payload.releasesAt,
            window: highestNew.window,
            used: payload.used,
            limit: payload.limit,
            percent: payload.percent,
            occurredAt: now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
          },
          `email-quota-admin:${highestNew.tenantId}:${highestNew.domain}:${highestNew.window}:${(highestNew.window === 'hour' ? hourStart : dayStart).toISOString().slice(0, 13)}`,
          // The subject, so the alert links to THIS tenant. /tenants (the list)
          // shows no sending limits; the tenant's own page does.
          highestNew.tenantId);
        } else {
          await notifyTenantEmailQuotaWarning(db, highestNew.tenantId, payload, emailDomainId);
        }
        notified += 1;
      } catch (err) {
        logger.error({ err, tenantId: highestNew.tenantId, domain: highestNew.domain }, 'mail thresholds: quota notification failed');
      }
    }
  }

  // Prune aged dedupe rows.
  await db.delete(emailQuotaEvents).where(
    lt(emailQuotaEvents.windowStart, sql`NOW() - INTERVAL '${sql.raw(String(QUOTA_EVENT_RETENTION_DAYS))} days'`),
  );

  return notified;
}

/** When mail a full window holds is retried: the next full UTC hour, or 00:00 UTC. */
export function releaseTime(window: 'hour' | 'day', now: Date): string {
  const period = window === 'hour' ? 3_600_000 : 86_400_000;
  const at = new Date((Math.floor(now.getTime() / period) + 1) * period);
  return window === 'hour' ? `${at.toISOString().slice(11, 16)} UTC` : `00:00 UTC (${at.toISOString().slice(0, 10)})`;
}

// ── Send-limit saturation (abuse) ───────────────────────────────────────────

/** Pure: combined reject volume + thresholds → severity. */
export function abuseLevel(total: number, warn: number, critical: number): 'critical' | 'warning' | null {
  if (total >= critical) return 'critical';
  if (total >= warn) return 'warning';
  return null;
}

async function getAbuseThresholds(db: Database): Promise<{ warn: number; critical: number }> {
  const rows = await db
    .select({ key: platformSettings.key, value: platformSettings.value })
    .from(platformSettings)
    .where(inArray(platformSettings.key, ['mail_abuse_warn_threshold', 'mail_abuse_critical_threshold']));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const parse = (v: string | undefined, fallback: number): number => {
    const n = v === undefined ? NaN : Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const warn = parse(byKey.get('mail_abuse_warn_threshold'), ABUSE_WARN_DEFAULT);
  const critical = parse(byKey.get('mail_abuse_critical_threshold'), ABUSE_CRITICAL_DEFAULT);
  // Keep critical ≥ warn so a mis-set pair can't invert severities.
  return { warn, critical: Math.max(critical, warn) };
}

interface AbuseRow {
  readonly tenantId: string;
  readonly domain: string | null;
  readonly rateLimited: number;
  readonly quotaRejected: number;
}

/**
 * Admin alert: a tenant/domain producing an abnormal volume of
 * rate-limited / quota-rejected outbound in the current hour. Reads the
 * already-metered emailSendCounters — no new ingestion. Dedupe is the
 * dispatcher's (admin recipient, dedupeKey) idempotency; the hour-bucket
 * key re-fires hourly while the burst persists.
 */
async function evaluateSendingAbuse(db: Database, logger: OutboundReconcileLogger): Promise<number> {
  const { warn, critical } = await getAbuseThresholds(db);

  const rows = (await db
    .select({
      tenantId: emailSendCounters.tenantId,
      domain: emailSendCounters.domain,
      rateLimited: sql<number>`COALESCE(SUM(${emailSendCounters.rateLimitedCount}), 0)`,
      quotaRejected: sql<number>`COALESCE(SUM(${emailSendCounters.quotaRejectedCount}), 0)`,
    })
    .from(emailSendCounters)
    .where(gte(emailSendCounters.bucketStart, sql`date_trunc('hour', NOW())`))
    .groupBy(emailSendCounters.tenantId, emailSendCounters.domain)) as AbuseRow[];

  const offending = rows.filter((r) => Number(r.rateLimited) + Number(r.quotaRejected) >= warn);
  if (offending.length === 0) return 0;

  const nameRows = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(inArray(tenants.id, [...new Set(offending.map((r) => r.tenantId))]));
  const names = new Map(nameRows.map((r) => [r.id, r.name]));

  const hourBucket = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  let fired = 0;

  for (const r of offending) {
    const rateLimited = Number(r.rateLimited);
    const quotaRejected = Number(r.quotaRejected);
    const total = rateLimited + quotaRejected;
    const level = abuseLevel(total, warn, critical);
    if (!level) continue;
    const domain = r.domain ?? 'unattributed';
    try {
      const { notifyAdminEmailSendingAbuse } = await import('../notifications/events.js');
      await notifyAdminEmailSendingAbuse(
        db,
        level,
        {
          tenantLabel: names.get(r.tenantId) ?? r.tenantId,
          domain,
          rateLimited: String(rateLimited),
          quotaRejected: String(quotaRejected),
          total: String(total),
          window: 'hour',
          recommendedAction: level === 'critical'
            ? 'suspend outbound mail for the tenant (TenantDetail → Outbound Mail) — likely a compromised account or a runaway loop'
            : 'throttle the tenant’s hourly send limit and investigate the sender',
        },
        `abuse:${r.tenantId}:${domain}:${level}:${hourBucket}`,
        r.tenantId,
      );
      fired += 1;
    } catch (err) {
      logger.error({ err, tenantId: r.tenantId, domain }, 'mail thresholds: abuse notification failed');
    }
  }

  return fired;
}

// ── Entry point ─────────────────────────────────────────────────────────────

export interface ThresholdEvaluationResult {
  readonly mode: MailEnforcementMode;
  readonly quotaNotifications: number;
  readonly abuseNotifications: number;
}

export async function evaluateMailThresholds(
  db: Database,
  logger: OutboundReconcileLogger,
): Promise<ThresholdEvaluationResult> {
  const mode = await getMailEnforcementMode(db);
  if (mode === 'off') {
    return { mode, quotaNotifications: 0, abuseNotifications: 0 };
  }

  const quotaNotifications = await evaluateQuotaUsage(db, logger, new Date()).catch((err) => {
    logger.error({ err }, 'mail thresholds: quota evaluation failed');
    return 0;
  });
  const abuseNotifications = await evaluateSendingAbuse(db, logger).catch((err) => {
    logger.error({ err }, 'mail thresholds: abuse evaluation failed');
    return 0;
  });

  if (quotaNotifications + abuseNotifications > 0) {
    logger.info({ mode, quotaNotifications, abuseNotifications }, 'mail thresholds: evaluated');
  }
  return { mode, quotaNotifications, abuseNotifications };
}

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
 * ## `auto` was removed with FBL (2026-09-15)
 *
 * The mode existed solely to act on FBL complaint rates: `mode === 'auto'`
 * appeared exactly once in this file, inside the complaint evaluator. With FBL
 * retired it would have been a setting that promises automatic enforcement and
 * silently does nothing — the stored-and-ignored class this codebase has spent
 * real effort deleting. Existing `auto` values migrate to `notify`, which is
 * what `auto` would now do anyway.
 *
 * Dedupe:
 *   - quota: PK insert on (tenant, window, threshold, window_start) —
 *     each calendar window fires each threshold at most once.
 */

import { and, eq, gte, lt, sql, inArray } from 'drizzle-orm';
import {
  tenants,
  hostingPlans,
  emailSendCounters,
  emailSenderCounters,
  emailQuotaEvents,
  auditLogs,
  platformSettings,
} from '../../db/schema.js';
import { buildEffectiveSendLimits } from '../email-outbound/rate-limit.js';
import type { Database } from '../../db/index.js';
import type { OutboundReconcileLogger } from '../email-outbound/service.js';
import { randomUUID } from 'node:crypto';

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

interface TenantUsageRow {
  readonly tenantId: string;
  readonly hourSent: number;
  readonly daySent: number;
}

export interface QuotaCrossing {
  readonly tenantId: string;
  readonly window: 'hour' | 'day';
  readonly threshold: 80 | 100;
  readonly used: number;
  readonly limit: number;
}

/**
 * Pure: usage rows + per-tenant limits -> threshold crossings.
 * A 100% crossing implies the 80% one; both rows are recorded but the
 * tenant is only notified at the HIGHEST new crossing per window.
 */
export function computeQuotaCrossings(
  usage: readonly TenantUsageRow[],
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
          crossings.push({ tenantId: u.tenantId, window, threshold, used, limit });
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
  window: 'hour' | 'day',
): Promise<string | null> {
  const since = window === 'hour'
    ? sql`date_trunc('hour', NOW())`
    : sql`date_trunc('day', NOW())`;
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
      ))
      .groupBy(emailSenderCounters.sender)
      .orderBy(sql`2 DESC`)
      .limit(5);
    if (rows.length === 0) return null;
    return rows.map((r) => `${r.sender} (${r.sent})`).join(', ');
  } catch {
    // An attribution we cannot read must not stop the alert that needs it.
    return null;
  }
}

async function evaluateQuotaUsage(db: Database, logger: OutboundReconcileLogger): Promise<number> {
  const usage = (await db
    .select({
      tenantId: emailSendCounters.tenantId,
      hourSent: sql<number>`COALESCE(SUM(${emailSendCounters.sentCount}) FILTER (WHERE ${emailSendCounters.bucketStart} >= date_trunc('hour', NOW())), 0)`,
      daySent: sql<number>`COALESCE(SUM(${emailSendCounters.sentCount}), 0)`,
    })
    .from(emailSendCounters)
    .where(gte(emailSendCounters.bucketStart, sql`date_trunc('day', NOW())`))
    .groupBy(emailSendCounters.tenantId)) as TenantUsageRow[];

  if (usage.length === 0) return 0;

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

  // Group by tenant+window so only the highest NEW threshold notifies.
  const byTenantWindow = new Map<string, QuotaCrossing[]>();
  for (const c of crossings) {
    const key = `${c.tenantId}|${c.window}`;
    byTenantWindow.set(key, [...(byTenantWindow.get(key) ?? []), c]);
  }

  for (const group of byTenantWindow.values()) {
    const sorted = [...group].sort((a, b) => b.threshold - a.threshold);
    let highestNew: QuotaCrossing | null = null;
    for (const c of sorted) {
      // Drizzle passes SQL fragments through verbatim in .values()
      // (is(value, SQL) check before Param wrapping) — the cast below
      // only silences the column type; DB-side date_trunc keeps the
      // dedupe key clock-skew-free across replicas.
      const windowStart = c.window === 'hour'
        ? sql`date_trunc('hour', NOW())`
        : sql`date_trunc('day', NOW())`;
      const inserted = await db
        .insert(emailQuotaEvents)
        .values({
          tenantId: c.tenantId,
          windowKind: c.window,
          threshold: c.threshold,
          windowStart: windowStart as unknown as Date,
        })
        .onConflictDoNothing()
        .returning({ threshold: emailQuotaEvents.threshold });
      if (inserted.length > 0 && !highestNew) highestNew = c;
    }

    if (highestNew) {
      try {
        const { notifyTenantEmailQuotaWarning, notifyTenantEmailQuotaExceeded } = await import('../notifications/events.js');
        const senders = await topSendersFor(db, highestNew.tenantId, highestNew.window);
        const payload = {
          window: highestNew.window,
          percent: String(Math.floor((highestNew.used / highestNew.limit) * 100)),
          used: String(highestNew.used),
          limit: String(highestNew.limit),
          topSenders: senders ?? 'no per-sender attribution recorded yet',
        };
        if (highestNew.threshold >= 100) {
          await notifyTenantEmailQuotaExceeded(db, highestNew.tenantId, payload);
          // The operator too, at 100% only. A tenant saturating the sending
          // limit is the shape of both a compromised account and a
          // platform-wide deliverability risk — and until now this event had
          // exactly one audience, so nobody on the platform side ever heard.
          const { notifyAdminEmailQuotaExceeded } = await import('../notifications/events.js');
          await notifyAdminEmailQuotaExceeded(db, {
            tenantLabel: tenantNames.get(highestNew.tenantId) ?? highestNew.tenantId,
            topSenders: payload.topSenders,
            window: highestNew.window,
            used: payload.used,
            limit: payload.limit,
            percent: payload.percent,
            occurredAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
          },
          `email-quota-admin:${highestNew.tenantId}:${highestNew.window}:${new Date().toISOString().slice(0, 10)}`,
          // The subject, so the alert links to THIS tenant. /tenants (the list)
          // shows no sending limits; the tenant's own page does.
          highestNew.tenantId);
        } else {
          await notifyTenantEmailQuotaWarning(db, highestNew.tenantId, payload);
        }
        notified += 1;
      } catch (err) {
        logger.error({ err, tenantId: highestNew.tenantId }, 'mail thresholds: quota notification failed');
      }
    }
  }

  // Prune aged dedupe rows.
  await db.delete(emailQuotaEvents).where(
    lt(emailQuotaEvents.windowStart, sql`NOW() - INTERVAL '${sql.raw(String(QUOTA_EVENT_RETENTION_DAYS))} days'`),
  );

  return notified;
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

  const quotaNotifications = await evaluateQuotaUsage(db, logger).catch((err) => {
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

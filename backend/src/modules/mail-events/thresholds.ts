/**
 * Outbound-mail threshold evaluator (R4/R6 PR 4).
 *
 * Runs on the 5-min mail tick. Two checks, both governed by the
 * `mail_enforcement_mode` platform setting (the admin control surface
 * in Mail Settings → Sending Protection):
 *
 *   off    — evaluator disabled entirely.
 *   notify — (DEFAULT) notifications only; admins act via the existing
 *            levers (per-tenant limits / outbound suspension).
 *   auto   — notifications PLUS automatic actions on complaint
 *            thresholds: warning (>0.1% 7d) halves the tenant's
 *            effective hourly limit; critical (>0.3%) suspends
 *            outbound mail. Every action writes an audit_logs row.
 *
 * Quota usage (80%/100% of hour/day windows) always notifies the
 * TENANT in notify+auto modes — usage warnings are informational and
 * never trigger automatic actions (Stalwart already enforces the
 * limit itself).
 *
 * Dedupe:
 *   - quota: PK insert on (tenant, window, threshold, window_start) —
 *     each calendar window fires each threshold at most once.
 *   - complaints: latest firing per (domain, level); re-fires after
 *     24h while still above threshold.
 */

import { eq, gte, lt, sql, inArray } from 'drizzle-orm';
import {
  tenants,
  hostingPlans,
  emailSendCounters,
  emailQuotaEvents,
  emailComplaintEvents,
  auditLogs,
  platformSettings,
} from '../../db/schema.js';
import { buildEffectiveSendLimits } from '../email-outbound/rate-limit.js';
import { complaintSummary } from './complaints.js';
import type { Database } from '../../db/index.js';
import type { OutboundReconcileLogger } from '../email-outbound/service.js';
import { randomUUID } from 'node:crypto';

export type MailEnforcementMode = 'off' | 'notify' | 'auto';

export const QUOTA_THRESHOLDS = [80, 100] as const;
export const COMPLAINT_WARNING_RATE = 0.001; // 0.1% (7d)
export const COMPLAINT_CRITICAL_RATE = 0.003; // 0.3% (7d)
const COMPLAINT_REFIRE_MS = 24 * 3_600_000;
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
/** Auto-throttle floor — never halve below this. */
const AUTO_THROTTLE_FLOOR = 1;

export async function getMailEnforcementMode(db: Database): Promise<MailEnforcementMode> {
  const [row] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, 'mail_enforcement_mode'));
  const v = row?.value;
  return v === 'off' || v === 'auto' ? v : 'notify';
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
        const payload = {
          window: highestNew.window,
          percent: String(Math.floor((highestNew.used / highestNew.limit) * 100)),
          used: String(highestNew.used),
          limit: String(highestNew.limit),
        };
        if (highestNew.threshold >= 100) {
          await notifyTenantEmailQuotaExceeded(db, highestNew.tenantId, payload);
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

// ── Complaint rates ─────────────────────────────────────────────────────────

export function complaintLevel(rate7d: number): 'critical' | 'warning' | null {
  if (rate7d > COMPLAINT_CRITICAL_RATE) return 'critical';
  if (rate7d > COMPLAINT_WARNING_RATE) return 'warning';
  return null;
}

async function evaluateComplaints(
  db: Database,
  logger: OutboundReconcileLogger,
  mode: MailEnforcementMode,
): Promise<number> {
  const summary = await complaintSummary(db);
  let fired = 0;

  for (const entry of summary) {
    if (!entry.domain) continue;
    const level = complaintLevel(entry.complaintRate7d);
    if (!level) continue;

    // Atomic test-and-set BEFORE any side effect: the upsert only
    // applies when the prior firing is older than the refire window,
    // and RETURNING tells us whether THIS replica won the slot. With
    // 2-3 HA replicas evaluating concurrently, exactly one dispatches
    // — no duplicate notifications, no double auto-actions. Trade-off:
    // if dispatch fails after winning, the slot stays consumed for
    // 24h — acceptable because the dispatcher persists failed
    // delivery rows (the no-silent-loss contract) for diagnosis.
    const won = await db.execute(sql`
      INSERT INTO email_complaint_events (domain, level, fired_at)
      VALUES (${entry.domain}, ${level}, NOW())
      ON CONFLICT (domain, level) DO UPDATE SET fired_at = NOW()
      WHERE email_complaint_events.fired_at < NOW() - INTERVAL '24 hours'
      RETURNING domain
    `);
    const wonRows = (won as unknown as { rows?: unknown[] }).rows ?? (Array.isArray(won) ? won : []);
    if (wonRows.length === 0) continue;

    let actionTaken = '';
    if (mode === 'auto' && entry.tenantId) {
      actionTaken = await applyAutoAction(db, logger, entry.tenantId, entry.domain, level);
    }

    try {
      const { notifyAdminEmailComplaint } = await import('../notifications/events.js');
      await notifyAdminEmailComplaint(db, level, {
        domain: entry.domain,
        tenantLabel: entry.tenantName ?? entry.tenantId ?? 'unattributed',
        ratePercent: (entry.complaintRate7d * 100).toFixed(2),
        complaints: String(entry.complaints7d),
        sends: String(entry.sent7d),
        recommendedAction: level === 'critical'
          ? 'suspend outbound mail for the tenant (TenantDetail → Outbound Mail)'
          : 'halve the tenant’s hourly send limit and investigate the sender',
        actionTaken: actionTaken || undefined,
      });
      fired += 1;
    } catch (err) {
      logger.error({ err, domain: entry.domain }, 'mail thresholds: complaint notification failed');
    }
  }

  return fired;
}

/**
 * Automatic enforcement (mode=auto only). Returns a human-readable
 * description of what was done, for the notification + audit trail.
 */
async function applyAutoAction(
  db: Database,
  logger: OutboundReconcileLogger,
  tenantId: string,
  domain: string,
  level: 'warning' | 'critical',
): Promise<string> {
  try {
    const [row] = await db
      .select({
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
      .leftJoin(hostingPlans, eq(tenants.planId, hostingPlans.id))
      .where(eq(tenants.id, tenantId));
    if (!row) return '';

    let description = '';
    if (level === 'critical') {
      if (row.emailOutboundSuspended) return 'Outbound mail already suspended.';
      await db.update(tenants)
        .set({ emailOutboundSuspended: true })
        .where(eq(tenants.id, tenantId));
      description = 'AUTO-ENFORCED: outbound mail suspended for the tenant.';
    } else {
      // Non-ratcheting: the throttle target is HALF THE PLAN VALUE,
      // not half the current effective limit — a 24h refire while the
      // rate stays elevated is a no-op instead of 50 -> 25 -> 12 -> 1.
      // Recovery (restoring the plan limit once the rate clears) is an
      // admin decision, consistent with notify-first philosophy; the
      // audit row + notification carry what was done.
      const effective = buildEffectiveSendLimits(row);
      const planBase = row.planHourly ?? effective.hourly.limit;
      const target = Math.max(AUTO_THROTTLE_FLOOR, Math.floor(planBase / 2));
      if (effective.hourly.limit <= target) {
        return `Hourly limit already at or below the auto-throttle target (${target}).`;
      }
      await db.update(tenants)
        .set({ emailSendRateLimit: target })
        .where(eq(tenants.id, tenantId));
      description = `AUTO-ENFORCED: hourly send limit reduced to ${target} (half the plan limit).`;
    }

    await db.insert(auditLogs).values({
      id: randomUUID(),
      tenantId,
      actionType: 'mail.auto_enforcement',
      resourceType: 'tenant_send_limits',
      resourceId: tenantId,
      actorId: 'system',
      actorType: 'system',
      changes: { level, domain, description },
    });

    const { reconcileStalwartSendLimits } = await import('../email-outbound/stalwart-throttles.js');
    await reconcileStalwartSendLimits(db, logger);

    logger.info({ tenantId, domain, level, description }, 'mail thresholds: auto action applied');
    return description;
  } catch (err) {
    logger.error({ err, tenantId, domain }, 'mail thresholds: auto action failed');
    return '';
  }
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
  readonly complaintNotifications: number;
  readonly abuseNotifications: number;
}

export async function evaluateMailThresholds(
  db: Database,
  logger: OutboundReconcileLogger,
): Promise<ThresholdEvaluationResult> {
  const mode = await getMailEnforcementMode(db);
  if (mode === 'off') {
    return { mode, quotaNotifications: 0, complaintNotifications: 0, abuseNotifications: 0 };
  }

  const quotaNotifications = await evaluateQuotaUsage(db, logger).catch((err) => {
    logger.error({ err }, 'mail thresholds: quota evaluation failed');
    return 0;
  });
  const complaintNotifications = await evaluateComplaints(db, logger, mode).catch((err) => {
    logger.error({ err }, 'mail thresholds: complaint evaluation failed');
    return 0;
  });
  const abuseNotifications = await evaluateSendingAbuse(db, logger).catch((err) => {
    logger.error({ err }, 'mail thresholds: abuse evaluation failed');
    return 0;
  });

  if (quotaNotifications + complaintNotifications + abuseNotifications > 0) {
    logger.info({ mode, quotaNotifications, complaintNotifications, abuseNotifications }, 'mail thresholds: evaluated');
  }
  return { mode, quotaNotifications, complaintNotifications, abuseNotifications };
}

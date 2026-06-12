/**
 * Stalwart send-limit reconciler (R6 PR 1).
 *
 * Materialises the plan-based per-tenant send limits as Stalwart
 * registry objects, replacing the dead [queue.throttle] TOML path
 * (v0.16 never read the stalwart-outbound-config ConfigMap).
 *
 * Desired state per enabled email domain:
 *   - active tenant:
 *       x:MtaOutboundThrottle  <prefix><domain>:hourly  rate N/1h
 *       x:MtaOutboundThrottle  <prefix><domain>:daily   rate N/1d
 *       x:MtaQueueQuota        <prefix><domain>:backlog messages=daily
 *         (caps the queued backlog so a burst can't park thousands of
 *          messages; submissions beyond it are rejected with a 4xx)
 *   - suspended / outbound-suspended tenant (or limit 0):
 *       x:MtaQueueQuota        <prefix><domain>:block   messages=0
 *         (every submission rejected — the suspension lever)
 *
 * All platform-managed objects carry the DESCRIPTION_PREFIX so the
 * diff only ever touches our own objects; operator-created throttles
 * are never modified or destroyed.
 *
 * Buckets are keyed by senderDomain: each of a tenant's domains gets
 * its own bucket with the tenant's limits (the practical per-customer
 * approximation — Stalwart has no tenant concept to key on).
 */

import { eq } from 'drizzle-orm';
import { tenants, hostingPlans, emailDomains, domains } from '../../db/schema.js';
import { buildEffectiveSendLimits } from './rate-limit.js';
import {
  mtaOutboundThrottleGet,
  mtaOutboundThrottleSet,
  mtaQueueQuotaGet,
  mtaQueueQuotaSet,
  type StalwartExpression,
} from '../stalwart-jmap/client.js';
import type { Database } from '../../db/index.js';
import type { OutboundReconcileLogger } from './service.js';

export const DESCRIPTION_PREFIX = 'platform:send-limit:';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface DomainSendLimit {
  readonly tenantId: string;
  readonly domain: string;
  readonly hourly: number;
  readonly daily: number;
  /** Suspension or a 0 limit — render a messages=0 quota instead. */
  readonly blocked: boolean;
}

export interface DesiredThrottle {
  readonly description: string;
  readonly enable: true;
  readonly key: { senderDomain: true };
  readonly match: StalwartExpression;
  readonly rate: { count: number; period: number };
}

export interface DesiredQueueQuota {
  readonly description: string;
  readonly enable: true;
  readonly key: { senderDomain: true };
  readonly match: StalwartExpression;
  readonly messages: number;
}

export interface DesiredSendLimitObjects {
  readonly throttles: ReadonlyMap<string, DesiredThrottle>;
  readonly quotas: ReadonlyMap<string, DesiredQueueQuota>;
}

// Mirrors the creation-time domainNameRegex (domains module): only
// [a-z0-9.-] can reach the DB. Re-checked here defensively because the
// value is interpolated into a single-quoted Stalwart expression — a
// row that somehow bypassed validation is dropped, never rendered.
const SAFE_DOMAIN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

function domainMatch(domain: string): StalwartExpression {
  // Boolean expressions go in `else` (the match list is the if/then
  // chain; an empty chain falls through to `else`).
  return { match: [], else: `sender_domain = '${domain}'` };
}

/**
 * Pure: rows -> desired registry objects, keyed by description.
 */
export function buildDesiredSendLimitObjects(
  rows: readonly DomainSendLimit[],
): DesiredSendLimitObjects {
  const throttles = new Map<string, DesiredThrottle>();
  const quotas = new Map<string, DesiredQueueQuota>();

  for (const row of rows) {
    if (!SAFE_DOMAIN.test(row.domain)) {
      // Defense in depth — see SAFE_DOMAIN. Skipping (not throwing)
      // keeps one bad row from wedging limits for every other tenant.
      continue;
    }
    const base = `${DESCRIPTION_PREFIX}${row.domain}`;
    if (row.blocked || row.hourly === 0 || row.daily === 0) {
      const description = `${base}:block`;
      quotas.set(description, {
        description,
        enable: true,
        key: { senderDomain: true },
        match: domainMatch(row.domain),
        messages: 0,
      });
      continue;
    }

    const hourlyDesc = `${base}:hourly`;
    throttles.set(hourlyDesc, {
      description: hourlyDesc,
      enable: true,
      key: { senderDomain: true },
      match: domainMatch(row.domain),
      rate: { count: row.hourly, period: HOUR_MS },
    });

    const dailyDesc = `${base}:daily`;
    throttles.set(dailyDesc, {
      description: dailyDesc,
      enable: true,
      key: { senderDomain: true },
      match: domainMatch(row.domain),
      rate: { count: row.daily, period: DAY_MS },
    });

    const backlogDesc = `${base}:backlog`;
    quotas.set(backlogDesc, {
      description: backlogDesc,
      enable: true,
      key: { senderDomain: true },
      match: domainMatch(row.domain),
      messages: row.daily,
    });
  }

  return { throttles, quotas };
}

/**
 * Load every enabled email domain with its tenant's resolved limits.
 */
export async function loadDomainSendLimits(
  db: Database,
): Promise<DomainSendLimit[]> {
  const rows = await db
    .select({
      tenantId: emailDomains.tenantId,
      domainName: domains.domainName,
      status: tenants.status,
      planId: tenants.planId,
      emailSendRateLimit: tenants.emailSendRateLimit,
      emailSendRateLimitDaily: tenants.emailSendRateLimitDaily,
      emailOutboundSuspended: tenants.emailOutboundSuspended,
      planCode: hostingPlans.code,
      planHourly: hostingPlans.emailHourlySendLimit,
      planDaily: hostingPlans.emailDailySendLimit,
    })
    .from(emailDomains)
    .innerJoin(domains, eq(emailDomains.domainId, domains.id))
    .innerJoin(tenants, eq(emailDomains.tenantId, tenants.id))
    .leftJoin(hostingPlans, eq(tenants.planId, hostingPlans.id))
    .where(eq(emailDomains.enabled, 1));

  return rows.map((r) => {
    const resolved = buildEffectiveSendLimits({
      status: r.status,
      planId: r.planId,
      emailSendRateLimit: r.emailSendRateLimit,
      emailSendRateLimitDaily: r.emailSendRateLimitDaily,
      emailOutboundSuspended: r.emailOutboundSuspended,
      planCode: r.planCode,
      planHourly: r.planHourly,
      planDaily: r.planDaily,
    });
    return {
      tenantId: r.tenantId,
      domain: r.domainName.toLowerCase(),
      hourly: resolved.hourly.limit,
      daily: resolved.daily.limit,
      // Any non-active lifecycle state (suspended, archived, pending,
      // deleted-in-flight) blocks sending — enforcement is stricter
      // than the inspection resolver, which only reports 'suspended'.
      blocked: resolved.suspended || resolved.outboundSuspended || r.status !== 'active',
    };
  });
}

export interface ThrottleReconcileResult {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly created: number;
  readonly updated: number;
  readonly destroyed: number;
}

function throttleNeedsUpdate(
  existing: { enable: boolean; match: StalwartExpression; rate: { count: number; period: number } },
  desired: DesiredThrottle,
): boolean {
  return (
    existing.enable !== desired.enable
    || existing.rate.count !== desired.rate.count
    || existing.rate.period !== desired.rate.period
    || existing.match.else !== desired.match.else
  );
}

function quotaNeedsUpdate(
  existing: { enable: boolean; match: StalwartExpression; messages: number | null },
  desired: DesiredQueueQuota,
): boolean {
  return (
    existing.enable !== desired.enable
    || (existing.messages ?? null) !== desired.messages
    || existing.match.else !== desired.match.else
  );
}

/**
 * Diff desired vs live platform-prefixed objects and apply.
 *
 * Stalwart applies registry throttle/quota changes without a restart
 * (verified live in the 2026-06-12 spike E2E for this PR) — no pod
 * roll is required here.
 */
export async function reconcileStalwartSendLimits(
  db: Database,
  logger: OutboundReconcileLogger,
  opts: { baseUrl?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ThrottleReconcileResult> {
  let desired: DesiredSendLimitObjects;
  try {
    desired = buildDesiredSendLimitObjects(await loadDomainSendLimits(db));
  } catch (err) {
    logger.error({ err }, 'send-limit reconcile: failed to load desired state');
    throw err;
  }

  let created = 0;
  let updated = 0;
  let destroyed = 0;

  try {
    // ── Throttles ──
    const liveThrottles = (await mtaOutboundThrottleGet(opts)).filter((t) =>
      t.description?.startsWith(DESCRIPTION_PREFIX),
    );
    const liveByDesc = new Map(liveThrottles.map((t) => [t.description, t]));

    const tCreate: Record<string, Record<string, unknown>> = {};
    const tUpdate: Record<string, Record<string, unknown>> = {};
    const tDestroy: string[] = [];

    for (const [desc, want] of desired.throttles) {
      const live = liveByDesc.get(desc);
      if (!live) {
        tCreate[`c-${created}`] = { ...want };
        created += 1;
      } else if (throttleNeedsUpdate(live, want)) {
        tUpdate[live.id] = { ...want };
        updated += 1;
      }
    }
    for (const live of liveThrottles) {
      if (!desired.throttles.has(live.description)) {
        tDestroy.push(live.id);
        destroyed += 1;
      }
    }

    if (Object.keys(tCreate).length || Object.keys(tUpdate).length || tDestroy.length) {
      const res = await mtaOutboundThrottleSet({
        ...(Object.keys(tCreate).length ? { create: tCreate } : {}),
        ...(Object.keys(tUpdate).length ? { update: tUpdate } : {}),
        ...(tDestroy.length ? { destroy: tDestroy } : {}),
        ...opts,
      });
      const failures = {
        ...res.notCreated,
        ...res.notUpdated,
        ...res.notDestroyed,
      };
      if (Object.keys(failures).length > 0) {
        logger.error({ failures }, 'send-limit reconcile: throttle set partially failed');
      }
    }

    // ── Queue quotas ──
    const liveQuotas = (await mtaQueueQuotaGet(opts)).filter((q) =>
      q.description?.startsWith(DESCRIPTION_PREFIX),
    );
    const liveQuotaByDesc = new Map(liveQuotas.map((q) => [q.description as string, q]));

    const qCreate: Record<string, Record<string, unknown>> = {};
    const qUpdate: Record<string, Record<string, unknown>> = {};
    const qDestroy: string[] = [];

    for (const [desc, want] of desired.quotas) {
      const live = liveQuotaByDesc.get(desc);
      if (!live) {
        qCreate[`c-${created}`] = { ...want };
        created += 1;
      } else if (quotaNeedsUpdate(live, want)) {
        qUpdate[live.id] = { ...want };
        updated += 1;
      }
    }
    for (const live of liveQuotas) {
      if (!desired.quotas.has(live.description as string)) {
        qDestroy.push(live.id);
        destroyed += 1;
      }
    }

    if (Object.keys(qCreate).length || Object.keys(qUpdate).length || qDestroy.length) {
      const res = await mtaQueueQuotaSet({
        ...(Object.keys(qCreate).length ? { create: qCreate } : {}),
        ...(Object.keys(qUpdate).length ? { update: qUpdate } : {}),
        ...(qDestroy.length ? { destroy: qDestroy } : {}),
        ...opts,
      });
      const failures = {
        ...res.notCreated,
        ...res.notUpdated,
        ...res.notDestroyed,
      };
      if (Object.keys(failures).length > 0) {
        logger.error({ failures }, 'send-limit reconcile: quota set partially failed');
      }
    }
  } catch (err) {
    // Stalwart unreachable (local dev without the mail stack, or a
    // mail-pod restart window). The next reconcile trigger re-runs the
    // full diff, so this is safe to surface as a skip rather than
    // failing the caller's request.
    logger.warn({ err }, 'send-limit reconcile: Stalwart JMAP unreachable, skipped');
    return { skipped: true, reason: 'stalwart unreachable', created: 0, updated: 0, destroyed: 0 };
  }

  logger.info(
    { created, updated, destroyed },
    'send-limit reconcile: Stalwart throttles/quotas reconciled',
  );
  return { skipped: false, created, updated, destroyed };
}

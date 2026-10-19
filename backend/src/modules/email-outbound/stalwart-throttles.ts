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

import { and, eq } from 'drizzle-orm';
import type { SendLimitLiveState } from '@insula/api-contracts';
import { tenants, hostingPlans, emailDomains, domains } from '../../db/schema.js';
import { buildEffectiveSendLimits } from './rate-limit.js';
import {
  mtaOutboundThrottleGet,
  mtaOutboundThrottleSet,
  mtaQueueQuotaGet,
  mtaQueueQuotaSet,
  actionReloadSettings,
  type StalwartExpression,
  type StalwartMtaThrottleRow,
  type StalwartMtaQueueQuotaRow,
} from '../stalwart-jmap/client.js';
import type { Database } from '../../db/index.js';
import { runExclusive, RUN_WAIT_MS } from '../../shared/exclusive-run.js';
import type { OutboundReconcileLogger } from './service.js';

export const DESCRIPTION_PREFIX = 'platform:send-limit:';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// Suspension lever: Stalwart validates messages >= 1 (a messages=0
// quota is rejected with MinValue), so a block is a 1-BYTE size quota
// — every real message exceeds it and submission is rejected at DATA
// with "452 4.3.1 Mail system full" (JMAP: forbiddenToSend). Proven
// live on v0.16.5.
export const BLOCK_SIZE_BYTES = 1;

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
  readonly messages: number | null;
  /** Bytes. Only set on :block quotas (see BLOCK_SIZE_BYTES). */
  readonly size: number | null;
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
  // Boolean expressions go in `else` (the match chain is empty and
  // falls through). The chain is a List<T> on the wire: an OBJECT
  // with integer-string keys — `[]` is rejected.
  //
  // `postmaster@` is exempt here too. This match backs the BLOCK quota for a
  // suspended tenant, and postmaster@ is the PLATFORM's address on their
  // domain — it carries DSNs and, once configured, outbound DMARC reports.
  // Blocking it would mean one tenant's suspension silently stopping platform
  // report traffic. A tenant cannot send as postmaster@ anyway: its primary
  // credential is generate-and-forget (ADR-049) and nobody holds it.
  return { match: {}, else: `sender_domain = '${domain}' && sender != 'postmaster@${domain}'` };
}

/**
 * Same bucket, but NOT for mail that never leaves this server.
 *
 * Stalwart evaluates these throttles per delivery attempt, and a
 * delivery to a mailbox on this same host runs in the `local` queue —
 * so without this clause an OUTBOUND send limit also governs
 * tenant-internal mail, the platform's own notification email, and
 * DMARC report intake. Measured on DEV, from Stalwart's log:
 *
 *   Rate limit exceeded (queue.rate-limit-exceeded)
 *     queueName = "local"  from = "postmaster@<apex>"
 *     id = "MtaOutboundThrottle with id <daily>"  limit = [100, 86400000ms]
 *     nextRetry = <next midnight UTC>
 *
 * 82 local messages were parked that way. The failure is near-silent:
 * the sender gets `250 … Message queued`, the mail sits up to a full
 * window (the daily bucket retries at midnight UTC), and only bounces
 * after `expires` — three days later.
 *
 * `queue_name` is the variable Stalwart exposes here; `is_local` and
 * `queue` are both rejected at parse time (probed live, same day).
 * Verified end-to-end: with this clause the identical message that was
 * being rate-limited logged `delivery.completed` in 0ms.
 */
function outboundDomainMatch(domain: string): StalwartExpression {
  // `postmaster@` is exempt, by operator decision.
  //
  // It is a PLATFORM address that happens to live on a tenant's domain: it
  // receives DSNs and reports, and once a DMARC report sender is configured it
  // also SENDS outbound aggregate reports. Throttle buckets are keyed by
  // sender DOMAIN, so without this clause the platform's own report traffic
  // would be charged to that tenant's hourly/daily plan allowance — the exact
  // shape of the storm, where platform mail consumed a customer's
  // quota and then alarmed about it.
  //
  // `sender` is the variable Stalwart exposes here. Probed live on DEV
  // `sender` is ACCEPTED; `sender_address` and `from` are both
  // rejected at parse time ("Error parsing 'else' expression"), which would
  // make the whole throttle write fail rather than degrade.
  return {
    match: {},
    else: `sender_domain = '${domain}' && queue_name != 'local' && sender != 'postmaster@${domain}'`,
  };
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
        messages: null,
        size: BLOCK_SIZE_BYTES,
      });
      continue;
    }

    const hourlyDesc = `${base}:hourly`;
    throttles.set(hourlyDesc, {
      description: hourlyDesc,
      enable: true,
      key: { senderDomain: true },
      match: outboundDomainMatch(row.domain),
      rate: { count: row.hourly, period: HOUR_MS },
    });

    const dailyDesc = `${base}:daily`;
    throttles.set(dailyDesc, {
      description: dailyDesc,
      enable: true,
      key: { senderDomain: true },
      match: outboundDomainMatch(row.domain),
      rate: { count: row.daily, period: DAY_MS },
    });

    const backlogDesc = `${base}:backlog`;
    quotas.set(backlogDesc, {
      description: backlogDesc,
      enable: true,
      key: { senderDomain: true },
      match: outboundDomainMatch(row.domain),
      messages: row.daily,
      size: null,
    });
  }

  return { throttles, quotas };
}

/**
 * Load every enabled email domain with its tenant's resolved limits.
 */
export async function loadDomainSendLimits(
  db: Database,
  /** One tenant's domains only; every tenant's when omitted. */
  tenantId?: string,
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
    .where(tenantId === undefined
      ? eq(emailDomains.enabled, 1)
      : and(eq(emailDomains.enabled, 1), eq(emailDomains.tenantId, tenantId)));

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

/**
 * `description` is the identity key we matched the live object BY, so it
 * can never differ — and Stalwart rejects it in a patch outright:
 *
 *   notUpdated: { "<id>": { "type": "invalidPatch",
 *     "description": "Cannot modify read-only property",
 *     "properties": ["description"] } }
 *
 * Measured on DEV against v0.16.20. Because the reconciler
 * spread the whole desired object into the patch, EVERY x:MtaQueueQuota
 * update had always failed — a plan change that raised a tenant's daily
 * limit left the backlog quota pinned at its original `messages` value
 * forever. Creates were unaffected, which is why it stayed hidden: a new
 * domain looked perfectly correct.
 *
 * (x:MtaOutboundThrottle happens to tolerate the resend, so throttles
 * updated fine — the asymmetry is exactly what made this a one-sided,
 * silent failure.)
 */
function patchWithoutIdentity<T extends { description: string }>(want: T): Record<string, unknown> {
  const { description: _ignored, ...rest } = want;
  return rest;
}

function quotaNeedsUpdate(
  existing: { enable: boolean; match: StalwartExpression; messages: number | null; size: number | null },
  desired: DesiredQueueQuota,
): boolean {
  return (
    existing.enable !== desired.enable
    || (existing.messages ?? null) !== desired.messages
    || (existing.size ?? null) !== desired.size
    || existing.match.else !== desired.match.else
  );
}

/**
 * Diff desired vs live platform-prefixed objects and apply.
 *
 * Stalwart applies registry throttle/quota changes without a restart
 * (verified live in the spike E2E for this PR) — no pod
 * roll is required here.
 */
/** The run lock of the send-limit reconcile (shared/exclusive-run.ts). */
const SEND_LIMIT_JOB = 'stalwart-send-limits';

/**
 * One description, one object: the first live object of each description, and
 * every further one with the same description. Stalwart keys these objects by
 * an id of its own, so nothing on its side stops two with one description.
 */
function byDescription<T extends { readonly description?: string | null }>(live: readonly T[]): { first: Map<string, T>; repeated: T[] } {
  const first = new Map<string, T>();
  const repeated: T[] = [];
  for (const obj of live) {
    const desc = obj.description as string;
    if (first.has(desc)) repeated.push(obj);
    else first.set(desc, obj);
  }
  return { first, repeated };
}

/**
 * Bring Stalwart's send limits in line with the plans and tenants — one
 * reconcile at a time, on any replica.
 *
 * Each reconcile reads what Stalwart holds and creates what is missing, and
 * is started from several places: the mail self-heal timer, and every route
 * that changes a plan, a tenant's limits or a mail domain. Two at once both
 * found a new domain's limits missing and both created them — and from then
 * on a changed limit was written to one copy only, with the other left
 * enforcing the old one. So a reconcile takes a run lock; one started while
 * another runs waits for it and then runs itself, because it may have been
 * started by a change the other has not read. Copies already there (made
 * before this lock, or behind a lock that lapsed) are removed by the diff.
 */
export async function reconcileStalwartSendLimits(
  db: Database,
  logger: OutboundReconcileLogger,
  opts: { baseUrl?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ThrottleReconcileResult> {
  const run = await runExclusive(db, SEND_LIMIT_JOB, () => reconcileSendLimitsOnce(db, logger, opts), { waitMs: RUN_WAIT_MS });
  if (run.ran) return run.value;
  // Still busy after the wait. The next trigger — the self-heal timer at the
  // latest — runs the full diff, so this is a skip, not a failure.
  logger.warn({ job: SEND_LIMIT_JOB }, 'send-limit reconcile: another reconcile was still running, skipped');
  return { skipped: true, reason: 'another reconcile was still running', created: 0, updated: 0, destroyed: 0 };
}

async function reconcileSendLimitsOnce(
  db: Database,
  logger: OutboundReconcileLogger,
  opts: { baseUrl?: string; env?: NodeJS.ProcessEnv },
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
    const { first: liveByDesc, repeated: repeatedThrottles } = byDescription(liveThrottles);

    const tCreate: Record<string, Record<string, unknown>> = {};
    const tUpdate: Record<string, Record<string, unknown>> = {};
    const tDestroy: string[] = [];

    for (const [desc, want] of desired.throttles) {
      const live = liveByDesc.get(desc);
      if (!live) {
        tCreate[`c-${created}`] = { ...want };
        created += 1;
      } else if (throttleNeedsUpdate(live, want)) {
        tUpdate[live.id] = patchWithoutIdentity(want);
        updated += 1;
      }
    }
    for (const live of liveByDesc.values()) {
      if (!desired.throttles.has(live.description)) {
        tDestroy.push(live.id);
        destroyed += 1;
      }
    }
    // A second object under one description is never right, wanted or not.
    for (const copy of repeatedThrottles) {
      tDestroy.push(copy.id);
      destroyed += 1;
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
    const { first: liveQuotaByDesc, repeated: repeatedQuotas } = byDescription(liveQuotas);

    const qCreate: Record<string, Record<string, unknown>> = {};
    const qUpdate: Record<string, Record<string, unknown>> = {};
    const qDestroy: string[] = [];

    for (const [desc, want] of desired.quotas) {
      const live = liveQuotaByDesc.get(desc);
      if (!live) {
        qCreate[`c-${created}`] = { ...want };
        created += 1;
      } else if (quotaNeedsUpdate(live, want)) {
        qUpdate[live.id] = patchWithoutIdentity(want);
        updated += 1;
      }
    }
    for (const live of liveQuotaByDesc.values()) {
      if (!desired.quotas.has(live.description as string)) {
        qDestroy.push(live.id);
        destroyed += 1;
      }
    }
    for (const copy of repeatedQuotas) {
      qDestroy.push(copy.id);
      destroyed += 1;
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

  // Stalwart reads MTA throttle/quota config at boot — without this
  // reload the running server keeps enforcing the OLD limits until the
  // next pod restart. Cheap no-op when
  // nothing changed.
  if (created + updated + destroyed > 0) {
    try {
      await actionReloadSettings(opts);
    } catch (err) {
      logger.error({ err }, 'send-limit reconcile: ReloadSettings failed — changes apply on next Stalwart restart');
    }
  }

  logger.info(
    { created, updated, destroyed },
    'send-limit reconcile: Stalwart throttles/quotas reconciled',
  );
  return { skipped: false, created, updated, destroyed };
}

type LiveDomain = SendLimitLiveState['domains'][number];

/**
 * Pure: what the mail server holds for these domains against what the
 * reconcile would make it hold. Judged by the reconcile's own comparisons, so
 * "in effect" here means exactly "the next reconcile would change nothing".
 */
export function compareSendLimitState(
  rows: readonly DomainSendLimit[],
  liveThrottles: readonly StalwartMtaThrottleRow[],
  liveQuotas: readonly StalwartMtaQueueQuotaRow[],
): LiveDomain[] {
  const desired = buildDesiredSendLimitObjects(rows);
  const throttlesOf = (desc: string) => liveThrottles.filter((t) => t.description === desc);
  const quotasOf = (desc: string) => liveQuotas.filter((q) => q.description === desc);

  return rows.map((row) => {
    const domain = row.domain;
    const base = `${DESCRIPTION_PREFIX}${domain}`;
    const hourly = throttlesOf(`${base}:hourly`);
    const daily = throttlesOf(`${base}:daily`);
    const backlog = quotasOf(`${base}:backlog`);
    const block = quotasOf(`${base}:block`);

    const ours = (desc: string | null | undefined) => desc != null && desc.startsWith(`${base}:`);
    const liveDescs = [
      ...liveThrottles.filter((t) => ours(t.description)).map((t) => t.description),
      ...liveQuotas.filter((q) => ours(q.description)).map((q) => q.description as string),
    ];
    const duplicates = liveDescs.length - new Set(liveDescs).size;

    const wantThrottles = [...desired.throttles.values()].filter((t) => ours(t.description));
    const wantQuotas = [...desired.quotas.values()].filter((q) => ours(q.description));
    const wanted = new Set([...wantThrottles, ...wantQuotas].map((o) => o.description));
    const throttlesMatch = wantThrottles.every((want) => {
      const live = throttlesOf(want.description);
      return live.length === 1 && !throttleNeedsUpdate(live[0]!, want);
    });
    const quotasMatch = wantQuotas.every((want) => {
      const live = quotasOf(want.description);
      return live.length === 1 && !quotaNeedsUpdate(live[0]!, want);
    });
    // A domain the builder refused (an unsafe name) wants nothing, so nothing
    // can be in effect for it.
    const inEffect = wanted.size > 0 && throttlesMatch && quotasMatch
      && liveDescs.every((d) => wanted.has(d)) && duplicates === 0;

    const blocked = row.blocked || row.hourly === 0 || row.daily === 0;
    return {
      domain,
      desired: { hourly: row.hourly, daily: row.daily, blocked },
      live: {
        hourly: hourly[0]?.enable ? hourly[0].rate.count : null,
        daily: daily[0]?.enable ? daily[0].rate.count : null,
        backlog: backlog[0]?.enable ? (backlog[0].messages ?? null) : null,
        blocked: block.some((q) => q.enable),
        duplicates,
      },
      inEffect,
    };
  });
}

/**
 * Read one tenant's send limits back from the mail server. Read-only: it
 * never writes, so it can run on every page view; an unreachable server is a
 * normal answer (`reachable: false`), not an error.
 */
export async function readTenantSendLimitState(
  db: Database,
  tenantId: string,
  opts: {
    baseUrl?: string;
    env?: NodeJS.ProcessEnv;
    now?: Date;
    /** Told why the mail server could not be read; the answer itself only says it could not. */
    logger?: Pick<OutboundReconcileLogger, 'warn'>;
  } = {},
): Promise<SendLimitLiveState> {
  const { now, logger, ...client } = opts;
  const rows = await loadDomainSendLimits(db, tenantId);
  const checkedAt = (now ?? new Date()).toISOString();
  try {
    const [throttles, quotas] = await Promise.all([mtaOutboundThrottleGet(client), mtaQueueQuotaGet(client)]);
    return { checkedAt, reachable: true, domains: compareSendLimitState(rows, throttles, quotas) };
  } catch (err) {
    logger?.warn({ err, tenantId }, 'send-limit live check: could not read the limits from Stalwart');
    return { checkedAt, reachable: false, domains: compareSendLimitState(rows, [], []).map((d) => ({ ...d, inEffect: false })) };
  }
}

/**
 * Stalwart webhook event ingest → email_send_counters (R6 PR 2).
 *
 * Wire format (batched by Stalwart, default 1s throttle):
 *   { "events": [ { id, createdAt, type, data } ] }
 *
 * Consumed event types:
 *   queue.authenticated-message-queued  -> sent/recipients/bytes
 *   queue.rate-limit-exceeded           -> rate_limited
 *   queue.quota-exceeded                -> quota_rejected
 *
 * Everything else (incl. the incoming-report.* family pre-subscribed
 * for R4 PR 3) is ignored here. Attribution is by envelope-sender
 * domain (`data.from`) -> email_domains row -> tenant; the same key
 * the Stalwart throttles enforce on. Events whose sender domain
 * doesn't resolve to a platform email domain are dropped (inbound
 * relay traffic, system mail).
 *
 * Counters are hourly buckets, upserted with ON CONFLICT .. DO UPDATE
 * increments so concurrent replicas / repeated batches never lose
 * counts. NOT per-message rows (descoped by the roadmap).
 */

import { sql, eq, inArray } from 'drizzle-orm';
import { emailDomains, domains, emailSendCounters } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

// Walk err.cause for the SQLSTATE code (Drizzle >=0.34 wraps pg errors).
function pgCode(e: unknown): string | undefined {
  let cur = e as { code?: string; cause?: unknown } | undefined;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur.code) return cur.code;
    cur = cur.cause as { code?: string; cause?: unknown } | undefined;
  }
  return undefined;
}

export interface StalwartWebhookEvent {
  readonly id?: string;
  readonly createdAt?: string;
  readonly type?: string;
  readonly data?: Record<string, unknown>;
}

export interface CounterDelta {
  tenantId: string;
  domain: string;
  bucketStart: Date;
  sentCount: number;
  recipientCount: number;
  bytesTotal: number;
  rateLimitedCount: number;
  quotaRejectedCount: number;
}

export interface IngestSummary {
  readonly received: number;
  readonly counted: number;
  readonly unattributed: number;
  readonly ignored: number;
}

function senderDomainOf(data: Record<string, unknown> | undefined): string | null {
  const from = data?.from;
  if (typeof from !== 'string') return null;
  const at = from.lastIndexOf('@');
  if (at < 1 || at === from.length - 1) return null;
  return from.slice(at + 1).toLowerCase();
}

function hourBucket(createdAt: string | undefined): Date {
  const t = createdAt ? new Date(createdAt) : new Date();
  const ms = Number.isFinite(t.getTime()) ? t.getTime() : Date.now();
  return new Date(Math.floor(ms / 3_600_000) * 3_600_000);
}

/**
 * Pure aggregation: events + (domain -> tenantId) resolution map ->
 * per-(tenant, domain, bucket) deltas. Exported for unit tests.
 */
export function aggregateEvents(
  events: readonly StalwartWebhookEvent[],
  domainToTenant: ReadonlyMap<string, string>,
): { deltas: CounterDelta[]; summary: IngestSummary } {
  const byKey = new Map<string, CounterDelta>();
  let counted = 0;
  let unattributed = 0;
  let ignored = 0;

  for (const ev of events) {
    const type = ev.type ?? '';
    if (
      type !== 'queue.authenticated-message-queued'
      && type !== 'queue.rate-limit-exceeded'
      && type !== 'queue.quota-exceeded'
    ) {
      ignored += 1;
      continue;
    }

    const domain = senderDomainOf(ev.data);
    const tenantId = domain ? domainToTenant.get(domain) : undefined;
    if (!domain || !tenantId) {
      unattributed += 1;
      continue;
    }

    const bucketStart = hourBucket(ev.createdAt);
    const key = `${tenantId}|${domain}|${bucketStart.toISOString()}`;
    let delta = byKey.get(key);
    if (!delta) {
      delta = {
        tenantId,
        domain,
        bucketStart,
        sentCount: 0,
        recipientCount: 0,
        bytesTotal: 0,
        rateLimitedCount: 0,
        quotaRejectedCount: 0,
      };
      byKey.set(key, delta);
    }

    if (type === 'queue.authenticated-message-queued') {
      delta.sentCount += 1;
      const to = ev.data?.to;
      delta.recipientCount += Array.isArray(to) ? to.length : 1;
      const size = ev.data?.size;
      delta.bytesTotal += typeof size === 'number' && Number.isFinite(size) ? Math.max(0, size) : 0;
    } else if (type === 'queue.rate-limit-exceeded') {
      delta.rateLimitedCount += 1;
    } else {
      delta.quotaRejectedCount += 1;
    }
    counted += 1;
  }

  return {
    deltas: [...byKey.values()],
    summary: { received: events.length, counted, unattributed, ignored },
  };
}

// ── Domain -> tenant resolution cache ──────────────────────────────────────
// One batch per ingest is already cheap, but webhook batches arrive
// every ~1s under load; a short TTL cache keeps steady-state ingest
// free of DB lookups. Negative results are cached too (inbound relay
// domains repeat constantly).

const DOMAIN_CACHE_TTL_MS = 60_000;
const domainCache = new Map<string, { tenantId: string | null; expires: number }>();

/** Test hook. */
export function clearDomainCache(): void {
  domainCache.clear();
}

async function resolveDomains(
  db: Database,
  wanted: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const misses: string[] = [];
  const now = Date.now();

  for (const d of wanted) {
    const hit = domainCache.get(d);
    if (hit && hit.expires > now) {
      if (hit.tenantId) result.set(d, hit.tenantId);
    } else {
      misses.push(d);
    }
  }

  if (misses.length > 0) {
    const rows = await db
      .select({ domainName: domains.domainName, tenantId: emailDomains.tenantId })
      .from(emailDomains)
      .innerJoin(domains, eq(emailDomains.domainId, domains.id))
      .where(inArray(sql`LOWER(${domains.domainName})`, misses));

    const found = new Map(rows.map((r) => [r.domainName.toLowerCase(), r.tenantId]));
    for (const d of misses) {
      const tenantId = found.get(d) ?? null;
      domainCache.set(d, { tenantId, expires: now + DOMAIN_CACHE_TTL_MS });
      if (tenantId) result.set(d, tenantId);
    }
  }

  return result;
}

export async function ingestMailEvents(
  db: Database,
  events: readonly StalwartWebhookEvent[],
): Promise<IngestSummary> {
  const wanted = [...new Set(
    events
      .map((ev) => senderDomainOf(ev.data))
      .filter((d): d is string => d !== null),
  )];
  const domainToTenant = wanted.length > 0 ? await resolveDomains(db, wanted) : new Map<string, string>();

  const { deltas, summary } = aggregateEvents(events, domainToTenant);

  for (const d of deltas) {
    try {
      await db
        .insert(emailSendCounters)
      .values({
        tenantId: d.tenantId,
        domain: d.domain,
        bucketStart: d.bucketStart,
        sentCount: d.sentCount,
        recipientCount: d.recipientCount,
        bytesTotal: d.bytesTotal,
        rateLimitedCount: d.rateLimitedCount,
        quotaRejectedCount: d.quotaRejectedCount,
      })
        .onConflictDoUpdate({
          target: [emailSendCounters.tenantId, emailSendCounters.domain, emailSendCounters.bucketStart],
          set: {
            sentCount: sql`${emailSendCounters.sentCount} + ${d.sentCount}`,
            recipientCount: sql`${emailSendCounters.recipientCount} + ${d.recipientCount}`,
            bytesTotal: sql`${emailSendCounters.bytesTotal} + ${d.bytesTotal}`,
            rateLimitedCount: sql`${emailSendCounters.rateLimitedCount} + ${d.rateLimitedCount}`,
            quotaRejectedCount: sql`${emailSendCounters.quotaRejectedCount} + ${d.quotaRejectedCount}`,
          },
        });
    } catch (err) {
      // 23503 = FK violation: the tenant was deleted while its domain
      // was still in the 60s cache. Drop the cache entry and skip the
      // delta — rethrowing would 500 the webhook and put non-lossy
      // Stalwart into a retry storm until discardAfter.
      if (pgCode(err) === '23503') {
        domainCache.delete(d.domain);
        continue;
      }
      throw err;
    }
  }

  return summary;
}

/**
 * Monitoring → Mail tab aggregate (PR 5).
 *
 * One read endpoint assembling everything the operator needs at a
 * glance: send totals, top senders, the live outbound queue, the
 * protection status (enforcement mode + report intake), and limit
 * trips. DMARC detail comes from /admin/mail/dmarc.
 */

import { sql, gte } from 'drizzle-orm';
import { emailSendCounters, tenants } from '../../db/schema.js';
import { queuedMessageList } from '../stalwart-jmap/client.js';
import { getMailEnforcementMode } from './thresholds.js';
import type { Database } from '../../db/index.js';
import type { MailOverviewResponse } from '@insula/api-contracts';
import { inArray } from 'drizzle-orm';

/**
 * Every sending domain of the last 7 days, not a top ten: the panel searches,
 * sorts and pages them, and a domain cut off at row eleven could not be found
 * by searching for it. Bounded all the same — one row per (tenant, domain).
 */
export const SENDER_ROWS_MAX = 1000;

/** Queued messages listed. The panel pages through them; "+" when cut off here. */
export const QUEUE_ROWS_MAX = 500;

export async function getMailOverview(db: Database): Promise<MailOverviewResponse> {
  const totalsP = db
    .select({
      // Same window as the top-senders `sent24h` below, so the tile equals the
      // sum of that column.
      sent24h: sql<number>`COALESCE(SUM(${emailSendCounters.sentCount}) FILTER (WHERE ${emailSendCounters.bucketStart} >= NOW() - INTERVAL '24 hours'), 0)`,
      sent7d: sql<number>`COALESCE(SUM(${emailSendCounters.sentCount}), 0)`,
      recipients7d: sql<number>`COALESCE(SUM(${emailSendCounters.recipientCount}), 0)`,
      rateLimited7d: sql<number>`COALESCE(SUM(${emailSendCounters.rateLimitedCount}), 0)`,
      quotaRejected7d: sql<number>`COALESCE(SUM(${emailSendCounters.quotaRejectedCount}), 0)`,
    })
    .from(emailSendCounters)
    .where(gte(emailSendCounters.bucketStart, sql`NOW() - INTERVAL '7 days'`));

  const topSendersP = db
    .select({
      tenantId: emailSendCounters.tenantId,
      domain: emailSendCounters.domain,
      sent24h: sql<number>`COALESCE(SUM(${emailSendCounters.sentCount}) FILTER (WHERE ${emailSendCounters.bucketStart} >= NOW() - INTERVAL '24 hours'), 0)`,
      sent7d: sql<number>`COALESCE(SUM(${emailSendCounters.sentCount}), 0)`,
      rateLimited7d: sql<number>`COALESCE(SUM(${emailSendCounters.rateLimitedCount}), 0)`,
      quotaRejected7d: sql<number>`COALESCE(SUM(${emailSendCounters.quotaRejectedCount}), 0)`,
    })
    .from(emailSendCounters)
    .where(gte(emailSendCounters.bucketStart, sql`NOW() - INTERVAL '7 days'`))
    .groupBy(emailSendCounters.tenantId, emailSendCounters.domain)
    // By the 7-day sum, named rather than by position. `ORDER BY 2` was the
    // DOMAIN column, so the "most active senders" were the ten domains last
    // in the alphabet, whatever they had sent.
    .orderBy(sql`COALESCE(SUM(${emailSendCounters.sentCount}), 0) DESC`, emailSendCounters.domain)
    .limit(SENDER_ROWS_MAX);

  const modeP = getMailEnforcementMode(db);

  // Queue is best-effort: Stalwart down must not blank the whole tab.
  const queueP = queuedMessageList({ limit: QUEUE_ROWS_MAX })
    .then((msgs) => ({
      reachable: true,
      depth: msgs.length,
      truncated: msgs.length >= QUEUE_ROWS_MAX,
      entries: msgs.map((m) => ({
        id: m.id,
        from: m.returnPath ?? '',
        recipients: Object.values(m.recipients ?? {})
          .map((r) => r?.address ?? '')
          .filter((a) => a.length > 0),
        createdAt: m.createdAt ?? null,
        nextRetry: m.nextRetry ?? null,
        size: typeof m.size === 'number' ? m.size : null,
      })),
    }))
    .catch(() => ({ reachable: false, depth: 0, truncated: false, entries: [] }));

  const [totalsRows, topSenders, mode, queue] = await Promise.all([totalsP, topSendersP, modeP, queueP]);
  const totals = totalsRows[0];

  const tenantNames = new Map<string, string>();
  if (topSenders.length > 0) {
    const rows = await db
      .select({ id: tenants.id, name: tenants.name })
      .from(tenants)
      .where(inArray(tenants.id, [...new Set(topSenders.map((t) => t.tenantId))]));
    for (const r of rows) tenantNames.set(r.id, r.name);
  }

  return {
    totals: {
      sent24h: Number(totals?.sent24h ?? 0),
      sent7d: Number(totals?.sent7d ?? 0),
      recipients7d: Number(totals?.recipients7d ?? 0),
      rateLimited7d: Number(totals?.rateLimited7d ?? 0),
      quotaRejected7d: Number(totals?.quotaRejected7d ?? 0),
    },
    topSenders: topSenders.map((t) => ({
      tenantId: t.tenantId,
      tenantName: tenantNames.get(t.tenantId) ?? null,
      domain: t.domain,
      sent24h: Number(t.sent24h),
      sent7d: Number(t.sent7d),
      rateLimited7d: Number(t.rateLimited7d),
      quotaRejected7d: Number(t.quotaRejected7d),
    })),
    queue,
    protection: { mode },
  };
}

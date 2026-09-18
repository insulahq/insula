/**
 * Mail-server health metrics collector.
 *
 * Publishes two FIRST-PARTY gauges on the platform-api :9090 /metrics
 * surface (already scraped by vmsingle — so no Stalwart scrape job or
 * mail port/cert change is needed):
 *
 *   platform_mail_server_up                    1 reachable / 0 expected-but-down
 *   platform_mail_outbound_queue_depth         queued messages (-1 = probe failed)
 *   platform_mail_platform_origin_queue_depth  of those, the ones WE sent
 *   platform_mail_drift_unresolved_age_hours   oldest unrepaired drift
 *
 * Presence gate: the gauges are published ONLY when mail is expected
 * (≥1 enabled email_domains row). On a cluster/dev without mail the
 * series stay absent, so the `mail-server-down` / `mail-queue-backlog`
 * rules see an empty vector and never false-fire. When mail IS expected
 * but the JMAP probe fails we publish 0 / -1 (rather than dropping the
 * series) so a real outage keeps the alert firing instead of going
 * stale after ~5min.
 *
 * Mirrors flux-status-collector: a 60s self-rescheduling timer whose
 * pass never throws by contract.
 */

import { sql } from 'drizzle-orm';
import { queuedMessageCount, queuedMessageList } from '../stalwart-jmap/client.js';
import {
  mailServerUp,
  mailOutboundQueueDepth,
  mailPlatformOriginQueueDepth,
  mailDriftOldestUnresolvedHours,
} from '../../shared/metrics.js';
import { sql as drizzleSql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';

export interface MailHealthCollectorLog {
  warn(...args: unknown[]): void;
}

/** True when the cluster has at least one enabled email domain. */
export async function mailIsExpected(db: Database): Promise<boolean> {
  const rows = await db.execute<{ n: number }>(
    sql`SELECT COUNT(*)::int AS n FROM email_domains WHERE enabled = 1`,
  );
  return Number(rows.rows?.[0]?.n ?? 0) > 0;
}

/** One collection pass. Never throws (fire-and-forget contract). */
export async function collectMailHealthOnce(db: Database, log: MailHealthCollectorLog): Promise<void> {
  let expected: boolean;
  try {
    expected = await mailIsExpected(db);
  } catch (err) {
    // Transient DB error — leave the gauges at their last value rather
    // than falsely reporting the mail server down.
    log.warn({ err }, 'mail-health-collector: presence gate query failed; skipping pass');
    return;
  }
  if (!expected) {
    // Mail not deployed — report "unknown" (-1), never 0 (which the rule
    // reads as "down"). Explicit set covers the case where mail was up and
    // then all email domains were disabled.
    mailServerUp.set(-1);
    mailOutboundQueueDepth.set(-1);
    mailPlatformOriginQueueDepth.set(-1);
    mailDriftOldestUnresolvedHours.set(-1);
    return;
  }

  // Drift age is a plain DB read — independent of whether Stalwart answers,
  // so it is collected before the JMAP probe and is not lost when mail is down.
  mailDriftOldestUnresolvedHours.set(await oldestUnresolvedDriftHours(db, log));

  try {
    const depth = await queuedMessageCount({ cap: 2000 });
    mailServerUp.set(1);
    mailOutboundQueueDepth.set(depth);

    // Classify by envelope sender so the platform alert cannot be tripped by
    // tenant mail. Below the floor there is nothing any threshold would fire
    // on, so skip the more expensive list call entirely — the common case
    // stays a single cheap count.
    if (depth < PLATFORM_ORIGIN_SCAN_FLOOR) {
      mailPlatformOriginQueueDepth.set(0);
    } else {
      mailPlatformOriginQueueDepth.set(await countPlatformOrigin(db, log));
    }
  } catch (err) {
    // Mail IS expected but the JMAP mgmt endpoint is unreachable → down.
    mailServerUp.set(0);
    mailOutboundQueueDepth.set(-1);
    mailPlatformOriginQueueDepth.set(-1);
    log.warn({ err }, 'mail-health-collector: Stalwart mgmt probe failed — mail_server_up=0');
  }
}

/**
 * Below this total depth we do not bother classifying: no useful platform
 * threshold sits under it, and the list call costs far more than the count.
 */
const PLATFORM_ORIGIN_SCAN_FLOOR = 25;

/** Bounded page. Above this the platform count is a LOWER BOUND — see below. */
const PLATFORM_ORIGIN_SCAN_LIMIT = 500;

/**
 * Count queued messages whose envelope sender belongs to a platform-owned
 * domain — i.e. mail the platform sent, not mail a tenant sent.
 *
 * Deliberately a lower bound when the queue exceeds the scan limit: the alert
 * fires on "too many", so undercounting can only delay it, never invent one.
 * Given the whole point is to stop tenant traffic paging the admin, erring
 * toward silence is the correct direction.
 *
 * Returns -1 (unknown) on failure, never 0.
 */
async function countPlatformOrigin(db: Database, log: MailHealthCollectorLog): Promise<number> {
  let platformDomains: ReadonlySet<string>;
  try {
    const rows = await db.execute<{ domain_name: string }>(drizzleSql`
      SELECT LOWER(d.domain_name) AS domain_name
        FROM email_domains ed
        JOIN domains d ON d.id = ed.domain_id
        JOIN tenants t ON t.id = d.tenant_id
       WHERE ed.enabled = 1 AND t.is_system = TRUE
    `);
    platformDomains = new Set((rows.rows ?? []).map((r) => r.domain_name));
  } catch (err) {
    log.warn({ err }, 'mail-health-collector: platform-domain lookup failed; origin split unknown');
    return -1;
  }
  if (platformDomains.size === 0) return 0;

  try {
    const page = await queuedMessageList({ limit: PLATFORM_ORIGIN_SCAN_LIMIT });
    let n = 0;
    for (const m of page) {
      const at = (m.returnPath ?? '').lastIndexOf('@');
      if (at < 0) continue;
      if (platformDomains.has(m.returnPath!.slice(at + 1).toLowerCase())) n++;
    }
    return n;
  } catch (err) {
    log.warn({ err }, 'mail-health-collector: queue listing failed; origin split unknown');
    return -1;
  }
}

/**
 * Start the 60s collector. Returns a stop function for onClose. Kicks
 * once immediately so a fresh boot publishes without waiting a full
 * interval.
 */
export function startMailHealthCollector(
  db: Database,
  log: MailHealthCollectorLog,
  intervalMs = 60_000,
): () => void {
  const runOnce = (): void => {
    collectMailHealthOnce(db, log).catch((err: unknown) => {
      log.warn({ err }, 'mail-health-collector: pass failed');
    });
  };
  runOnce();
  const timer = setInterval(runOnce, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Hours since the oldest unresolved mail-drift item was first detected.
 * 0 unresolved → -1 (nothing to report), probe failure → -1 (unknown).
 * Both are "no alert", and neither is a misleading 0.
 */
async function oldestUnresolvedDriftHours(
  db: Database,
  log: MailHealthCollectorLog,
): Promise<number> {
  try {
    const rows = await db.execute<{ hours: number | null }>(drizzleSql`
      SELECT EXTRACT(EPOCH FROM (NOW() - MIN(first_detected_at))) / 3600 AS hours
        FROM mail_drift_items
       WHERE resolved_at IS NULL
    `);
    const hours = rows.rows?.[0]?.hours;
    return hours === null || hours === undefined ? -1 : Math.floor(Number(hours));
  } catch (err) {
    log.warn({ err }, 'mail-health-collector: drift-age query failed');
    return -1;
  }
}

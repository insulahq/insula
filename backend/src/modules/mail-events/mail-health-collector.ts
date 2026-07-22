/**
 * Mail-server health metrics collector (mail monitoring, 2026-07).
 *
 * Publishes two FIRST-PARTY gauges on the platform-api :9090 /metrics
 * surface (already scraped by vmsingle — so no Stalwart scrape job or
 * mail port/cert change is needed):
 *
 *   platform_mail_server_up          1 reachable / 0 expected-but-down
 *   platform_mail_outbound_queue_depth  queued messages (-1 = probe failed)
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
import { queuedMessageCount } from '../stalwart-jmap/client.js';
import { mailServerUp, mailOutboundQueueDepth } from '../../shared/metrics.js';
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
    return;
  }

  try {
    const depth = await queuedMessageCount({ cap: 2000 });
    mailServerUp.set(1);
    mailOutboundQueueDepth.set(depth);
  } catch (err) {
    // Mail IS expected but the JMAP mgmt endpoint is unreachable → down.
    mailServerUp.set(0);
    mailOutboundQueueDepth.set(-1);
    log.warn({ err }, 'mail-health-collector: Stalwart mgmt probe failed — mail_server_up=0');
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

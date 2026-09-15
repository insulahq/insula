/**
 * Escalation sweep.
 *
 * Runs once at startup, then hourly. The startup run matters for the same
 * reason it does in the retention and digest passes: a cluster that rolls
 * platform-api more often than the interval never reaches a tick otherwise.
 *
 * Hourly against a 48-hour deadline is deliberately coarse — escalation is a
 * backstop, not a timer, and a finer sweep would add load for no earlier
 * signal.
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { safeTick } from '../../../shared/safe-tick.js';
import { notificationDeliveries } from '../../../db/schema.js';
import {
  findEscalationCandidates,
  markEscalated,
  describeCandidates,
  ESCALATE_AFTER_HOURS,
} from './service.js';
import { notifyAdminEscalation } from '../events.js';
import type { Database } from '../../../db/index.js';

const TICK_MS = 60 * 60 * 1000;

export function startEscalationScheduler(db: Database): NodeJS.Timeout {
  safeTick('notification-escalation', () => runOnce(db));
  const timer = setInterval(() => {
    safeTick('notification-escalation', () => runOnce(db));
  }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

export async function runOnce(db: Database, now: Date = new Date()): Promise<number> {
  const candidates = await findEscalationCandidates(db, now);
  if (candidates.length === 0) return 0;

  // The dedupe key identifies the BATCH, not the day.
  //
  // It was `escalation:<date>`, which looked right and lost notifications.
  // `findEscalationCandidates` caps at 200 rows and filters to Action AFTER
  // the query, so a backlog drains over several ticks — each tick a genuinely
  // different set of notifications. With a per-day key only the first tick
  // ever dispatched; every later batch was silently deduped while
  // `markEscalated` marked it anyway. Measured on DEV: two escalation
  // notifications existed, both from 01:47, while 45 rows carried
  // `escalated_at` — 45 unread actions marked "chased" that nobody was told
  // about, and permanently ineligible to escalate again.
  //
  // Hashing the candidate ids means an identical batch still dedupes (a tick
  // that finds the same work twice does not spam) while a new batch always
  // gets through.
  const batchHash = createHash('sha256')
    .update(candidates.map((c) => c.id).sort().join(','))
    .digest('hex')
    .slice(0, 16);
  const dedupeKey = `escalation:${now.toISOString().slice(0, 10)}:${batchHash}`;

  // ONE aggregated escalation, not one per notification. The operator needs a
  // list of what is being ignored, not a replay of every message the recipient
  // already received and did not read.
  await notifyAdminEscalation(db, {
    count: String(candidates.length),
    ageHours: String(ESCALATE_AFTER_HOURS),
    summary: describeCandidates(candidates),
  }, dedupeKey);

  // Mark ONLY if the operator was actually told.
  //
  // `dispatchSafe` returns void and swallows its own errors by contract, so
  // "the await resolved" says nothing about whether a delivery exists. Ask the
  // table instead. No delivery means no one was told, so the rows stay
  // eligible and the next tick retries them — which is the whole point of
  // marking after dispatch rather than before.
  const [delivered] = await db
    .select({ id: notificationDeliveries.id })
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.dedupeKey, dedupeKey))
    .limit(1);
  if (!delivered) {
    console.warn(
      `[notification-escalation] ${candidates.length} candidate(s) not marked — no delivery for ${dedupeKey}; will retry`,
    );
    return 0;
  }

  await markEscalated(db, candidates.map((c) => c.id), now);
  console.log(`[notification-escalation] escalated ${candidates.length} unread action notification(s)`);
  return candidates.length;
}

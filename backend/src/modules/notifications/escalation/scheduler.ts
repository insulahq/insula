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
import { and, eq, inArray } from 'drizzle-orm';
import { safeTick } from '../../../shared/safe-tick.js';
import { notificationDeliveries } from '../../../db/schema.js';
import {
  findEscalationCandidates,
  markEscalated,
  describeCandidates,
  concernsTenants,
  countEvents,
  ESCALATE_AFTER_HOURS,
} from './service.js';
import { notifyAdminEscalation } from '../events.js';
import type { Database } from '../../../db/index.js';
import { withSchedulerLease } from '../../../shared/scheduler-lease.js';

const TICK_MS = 60 * 60 * 1000;

/** Delivery statuses that mean an admin was told (or chose not to be). */
const TOLD = ['queued', 'sending', 'sent', 'muted'] as const;

export function startEscalationScheduler(db: Database): NodeJS.Timeout {
  // One replica escalates: the batch is sent before its rows are marked, so two
  // replicas reading the same unmarked rows would both send it.
  const tick = (): void => safeTick(
    'notification-escalation',
    () => withSchedulerLease(db, 'notification-escalation', TICK_MS * 1.5, () => runOnce(db)),
  );
  tick();
  const timer = setInterval(tick, TICK_MS);
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
  //
  // The items name tenants and quote their notifications (the full mailbox,
  // the sending accounts), so the reminder is tenant-scoped content: it may go
  // to each admin's bell and email, never to a shared push topic.
  await notifyAdminEscalation(db, {
    count: String(countEvents(candidates)),
    ageHours: String(ESCALATE_AFTER_HOURS),
    summary: describeCandidates(candidates),
  }, dedupeKey, { tenantScopedContent: concernsTenants(candidates) });

  // Mark ONLY if the operator was actually told.
  //
  // `dispatchSafe` returns void and swallows its own errors by contract, so
  // "the await resolved" says nothing about whether a delivery exists. Ask the
  // table instead. No delivery means no one was told, so the rows stay
  // eligible and the next tick retries them — which is the whole point of
  // marking after dispatch rather than before.
  //
  // A row under the key is not enough: `rate_limited` and `skipped` (no email
  // address, no template) are written under it too, and told nobody. `muted`
  // counts — the admin chose not to hear it, and retrying hourly would not
  // change that. A batch that reached nobody is retried under the NEXT day's
  // key: the dispatcher treats any row under a key as already fired, so the
  // rest of today's ticks dedupe against it.
  const [delivered] = await db
    .select({ id: notificationDeliveries.id })
    .from(notificationDeliveries)
    .where(and(
      eq(notificationDeliveries.dedupeKey, dedupeKey),
      inArray(notificationDeliveries.status, [...TOLD]),
    ))
    .limit(1);
  if (!delivered) {
    console.warn(
      `[notification-escalation] ${candidates.length} candidate(s) not marked — no delivery for ${dedupeKey}; will retry`,
    );
    return 0;
  }

  await markEscalated(db, candidates, now);
  console.log(`[notification-escalation] escalated ${candidates.length} unread action notification(s)`);
  return candidates.length;
}

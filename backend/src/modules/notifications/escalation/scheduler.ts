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
import { safeTick } from '../../../shared/safe-tick.js';
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

  // ONE aggregated escalation, not one per notification. The operator needs a
  // list of what is being ignored, not a replay of every message the recipient
  // already received and did not read.
  await notifyAdminEscalation(db, {
    count: String(candidates.length),
    ageHours: String(ESCALATE_AFTER_HOURS),
    summary: describeCandidates(candidates),
  }, `escalation:${now.toISOString().slice(0, 10)}`);

  // Marked only AFTER the dispatch above resolves. If it throws, these rows
  // stay eligible and the next sweep retries them; marking first would drop
  // the escalation silently.
  await markEscalated(db, candidates.map((c) => c.id), now);
  console.log(`[notification-escalation] escalated ${candidates.length} unread action notification(s)`);
  return candidates.length;
}

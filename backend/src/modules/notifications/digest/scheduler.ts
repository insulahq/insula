/**
 * Digest flush.
 *
 * Runs once at startup, then every 15 minutes. The startup run matters for the
 * same reason it matters in the retention pass: the DEV cluster re-pins images
 * on every push and rolls platform-api with it, so a scheduler that only ever
 * fires on an interval can go indefinitely without running there.
 *
 * Fifteen minutes is finer than the shortest digest window (hourly) on purpose
 * — the window is measured from the oldest queued item, so a coarser tick would
 * add up to its own period of latency on top of the window the user chose.
 */
import { eq, inArray } from 'drizzle-orm';
import { users, userNotificationSettings } from '../../../db/schema.js';
import { safeTick } from '../../../shared/safe-tick.js';
import {
  dueDigests,
  renderDigest,
  markSent,
  type DigestMode,
} from './service.js';
import { notifyUserDigest } from '../events.js';
import type { Database } from '../../../db/index.js';

const TICK_MS = 15 * 60 * 1000;

export function startDigestScheduler(db: Database): NodeJS.Timeout {
  safeTick('notification-digest', () => runOnce(db));
  const timer = setInterval(() => {
    safeTick('notification-digest', () => runOnce(db));
  }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

export async function runOnce(db: Database, now: Date = new Date()): Promise<number> {
  // Load every user's mode once rather than per item: the flush query already
  // returns every pending item, and a per-user settings read inside the loop
  // turns one pass into N round-trips.
  const settings = await db
    .select({ userId: userNotificationSettings.userId, digestMode: userNotificationSettings.digestMode })
    .from(userNotificationSettings);
  const modes = new Map<string, DigestMode>(
    settings.map((s) => [s.userId, (s.digestMode ?? 'immediate') as DigestMode]),
  );

  const due = await dueDigests(db, (uid) => modes.get(uid) ?? 'immediate', now);
  if (due.length === 0) return 0;

  let sent = 0;
  for (const digest of due) {
    const { subject, body, itemsHtml } = renderDigest(digest.items);
    try {
      // Dispatched through the ordinary path, so the digest itself gets a
      // template, a delivery row and a retry — it is a notification, not a
      // special case that bypasses everything the rest of this work built.
      await notifyUserDigest(db, digest.userId, {
        itemCount: String(digest.items.length),
        summary: subject,
        items: body,
        itemsHtml,
      });
      await markSent(db, digest.items.map((i) => i.id), now);
      sent += 1;
    } catch (err) {
      // Leave the items unsent: the next tick retries them. Marking them sent
      // on a failed dispatch would silently discard the batch, which is the
      // failure mode this whole overhaul exists to remove.
      console.warn(
        `[notification-digest] flush failed for user ${digest.userId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (sent > 0) console.log(`[notification-digest] sent ${sent} digest(s)`);
  return sent;
}

/** Exported for the scheduler test; keeps the import graph honest. */
export const __deps = { users, eq, inArray };

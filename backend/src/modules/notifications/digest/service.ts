/**
 * Periodic notification digests.
 *
 * `digest_mode` ('immediate' | 'hourly' | 'daily') has been a stored, API-
 * exposed, UI-rendered user preference since the preferences module shipped,
 * and nothing read it. A user could select "daily", watch it save, and keep
 * receiving every email the moment it fired. This module is what makes the
 * setting mean something.
 *
 * What may be delayed
 * -------------------
 * Only digestible classes: ambient, record and action. Incident, Availability
 * and Security are never queued, for the same reason they bypass quiet hours —
 * a digest IS a delay, and those three are the classes that cannot absorb one.
 * The check is the class policy, not a second list that can drift from it.
 *
 * Only the EMAIL channel. The in-app row is written immediately regardless:
 * batching a panel notification helps nobody, because the panel is already a
 * list the reader chooses when to open.
 */
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { notificationDigestItems } from '../../../db/schema.js';
import { categoryMeta } from '../routing/effective-channels.js';
import { CLASS_POLICY } from '../routing/classes.js';
import type { Database } from '../../../db/index.js';

export type DigestMode = 'immediate' | 'hourly' | 'daily';

/** How long a queued item waits before its digest is due. */
const WINDOW_MS: Record<Exclude<DigestMode, 'immediate'>, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
};

/** Sent items are kept briefly so a "why did I get this" question is answerable. */
export const DIGEST_ITEM_RETENTION_DAYS = 7;

/**
 * May this notification be held back for a digest?
 *
 * Reads the class policy rather than a parallel list — a digest exemption that
 * can drift from the quiet-hours exemption is two rules for one question.
 */
export function isDigestible(categoryId: string, mode: DigestMode): boolean {
  if (mode === 'immediate') return false;
  // The digest itself is never digestible. Queuing a digest into a digest is
  // how it stops arriving at all.
  if (categoryId === 'platform.digest') return false;
  const meta = categoryMeta(categoryId);
  if (!meta) return false;
  const policy = CLASS_POLICY[meta.cls];
  return policy.digestible && !policy.mandatory;
}

export interface QueueInput {
  readonly userId: string;
  readonly categoryId: string;
  readonly subject: string;
  readonly body: string;
}

export async function queueForDigest(db: Database, input: QueueInput): Promise<void> {
  await db.insert(notificationDigestItems).values({
    userId: input.userId,
    categoryId: input.categoryId,
    subject: input.subject.slice(0, 500),
    body: input.body.slice(0, 10_000),
  });
}

export interface PendingDigest {
  readonly userId: string;
  readonly items: ReadonlyArray<{ id: string; subject: string; body: string; categoryId: string }>;
}

/**
 * Items whose window has elapsed, grouped by user.
 *
 * The window is measured from the OLDEST unsent item, not from the last flush:
 * a user who receives one notification a week should get it a day later, not
 * held until something else arrives to trigger a batch.
 */
/**
 * Hard cap on one flush pass.
 *
 * The queue is drained every 15 minutes, so this is a ceiling on a backlog,
 * not on throughput: whatever a pass leaves behind is picked up by the next
 * one. Without it a scheduler that had been down for a day would load the
 * entire queue into memory at once — an unbounded read is unbounded memory
 * even when the TABLE is bounded.
 */
export const MAX_ITEMS_PER_PASS = 2_000;

export async function dueDigests(
  db: Database,
  modeForUser: (userId: string) => DigestMode,
  now: Date = new Date(),
): Promise<PendingDigest[]> {
  const rows = await db
    .select({
      id: notificationDigestItems.id,
      userId: notificationDigestItems.userId,
      categoryId: notificationDigestItems.categoryId,
      subject: notificationDigestItems.subject,
      body: notificationDigestItems.body,
      createdAt: notificationDigestItems.createdAt,
    })
    .from(notificationDigestItems)
    .where(isNull(notificationDigestItems.sentAt))
    .orderBy(asc(notificationDigestItems.createdAt))
    .limit(MAX_ITEMS_PER_PASS);

  const byUser = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byUser.get(r.userId);
    if (list) list.push(r);
    else byUser.set(r.userId, [r]);
  }

  const due: PendingDigest[] = [];
  for (const [userId, items] of byUser) {
    const mode = modeForUser(userId);
    if (mode === 'immediate') {
      // The user turned the digest off while items were queued. Flush them
      // rather than stranding them: a preference change must not orphan
      // notifications that are already waiting.
      due.push({ userId, items });
      continue;
    }
    const oldest = items[0]?.createdAt;
    if (!oldest) continue;
    if (now.getTime() - new Date(oldest).getTime() >= WINDOW_MS[mode]) {
      due.push({ userId, items });
    }
  }
  return due;
}

/** Render one digest body. Plain text: it is a list, not a document. */
/** Items named individually in one digest body; the rest are counted. */
export const MAX_ITEMS_RENDERED = 50;

export function renderDigest(items: PendingDigest['items']): { subject: string; body: string } {
  const n = items.length;
  const subject = n === 1
    ? items[0].subject
    : `${n} notifications`;
  const shown = items.slice(0, MAX_ITEMS_RENDERED);
  const lines = shown.map((i, idx) => `${idx + 1}. ${i.subject}\n   ${i.body}`);
  if (items.length > shown.length) {
    // Naming 800 notifications individually is not a digest, and the row has a
    // column limit regardless.
    lines.push(`… and ${items.length - shown.length} more.`);
  }
  return { subject, body: lines.join('\n\n') };
}

export async function markSent(db: Database, ids: readonly string[], now: Date = new Date()): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(notificationDigestItems)
    .set({ sentAt: now })
    // Same fix as escalation/service.ts:markEscalated — see the note there.
    // This copy had not thrown yet only because no DEV user has a digest mode
    // set, so the path had never run. Identical latent bug.
    .where(inArray(notificationDigestItems.id, [...ids]));
}

/**
 * Bounded growth: a sent item is history, and the delivery row is the durable
 * audit. Seven days is enough to answer "why did I get this".
 */
export async function purgeSentDigestItems(db: Database, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - DIGEST_ITEM_RETENTION_DAYS * 86_400_000);
  const rows = await db
    .delete(notificationDigestItems)
    .where(and(
      sql`${notificationDigestItems.sentAt} IS NOT NULL`,
      lt(notificationDigestItems.sentAt, cutoff),
    ))
    .returning({ id: notificationDigestItems.id });
  return rows.length;
}

/** Test seam + explicit re-export so the retention guard can see the table. */
export const __digestTable = notificationDigestItems;
export { eq };

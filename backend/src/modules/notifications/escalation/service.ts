/**
 * Escalation of unacknowledged action notifications.
 *
 * An Action-class notification says: do something, or this degrades. Until
 * now, one that was never read simply sat there. The platform could not tell
 * "told and handled" from "told and ignored" — a tenant who fixed the problem
 * and a tenant who never opened their panel looked identical, and the only
 * signal either way was the operator eventually noticing the underlying
 * condition had not cleared.
 *
 * What escalates
 * --------------
 * Only Action. Ambient and Record ask for nothing, so there is nothing to
 * chase. Incident, Availability and Security already reach every channel the
 * audience has at the moment they fire — there is no higher level to go to,
 * and pretending otherwise would just send a second copy.
 *
 * Whose
 * -----
 * Only the platform admins' own notifications, unread by every admin.
 *
 * Tenants' notifications used to escalate to the admins too, on the theory
 * that the operator can act when a customer has not. Removed by operator
 * decision. "Unread" is the in-app copy, and a tenant who reads
 * the email and never opens the panel looked like a tenant ignoring it: all
 * 36 reminders production sent in its first month were about tenants'
 * notifications. None was one the operator could see, open, mark read, or act
 * on. What the operator should know about a tenant has its own admin
 * notification (send abuse, mailboxes near quota, subscriptions expiring).
 *
 * Exactly once, enforced by `notifications.escalated_at`. An escalation that
 * repeats every tick is the noise it was built to cut through.
 */
import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { notifications, tenants, users } from '../../../db/schema.js';
import { ALL_CATEGORIES } from '../categories/seed.js';
import type { Database } from '../../../db/index.js';
import { cappedList } from '../list-items.js';

/** How long an action may sit unread before the operator is told. */
export const ESCALATE_AFTER_HOURS = 48;

export interface EscalationCandidate {
  readonly id: string;
  readonly userId: string;
  readonly categoryId: string | null;
  readonly title: string;
  readonly message: string;
  readonly createdAt: Date;
  /** Copies of one event share it; null on rows older than the event model. */
  readonly eventId: string | null;
  /** The tenant the admin's notification is about, if any. */
  readonly tenantName: string | null;
  /**
   * Its text concerns a tenant (the row carries a tenant). Read from the row,
   * not from the name, so a reminder quoting it stays off the shared push topic.
   */
  readonly tenantScoped: boolean;
}

/**
 * Categories worth chasing: Action, unless the category says its condition
 * is over before the deadline (`escalates: false`).
 *
 * Class, not severity: an `info`-severity action (a subscription expiring in
 * five weeks) still needs chasing, and a `critical`-severity incident does
 * not, because it already went everywhere on the first attempt.
 */
const ESCALATABLE: ReadonlySet<string> = new Set(
  ALL_CATEGORIES.filter((c) => c.cls === 'action' && c.escalates !== false).map((c) => c.id),
);

export function isEscalatable(categoryId: string | null | undefined): boolean {
  return Boolean(categoryId && ESCALATABLE.has(categoryId));
}

/**
 * Platform admins' unread, never-escalated, escalatable notifications past the
 * deadline that no admin has read, oldest first.
 *
 * The category filter is in SQL. It used to run after the query, so the 200
 * rows the query returned included unread Ambient and Record rows — which are
 * never marked escalated and so came back on every tick, and once there were
 * 200 of them no Action row would ever have been seen again.
 *
 * "No admin read it": one event writes a row per admin. When one of them has
 * read it, it was seen, and chasing the others' copies is a reminder "mark
 * all as read" cannot stop.
 */
export async function findEscalationCandidates(
  db: Database,
  now: Date = new Date(),
  limit = 200,
): Promise<EscalationCandidate[]> {
  const cutoff = new Date(now.getTime() - ESCALATE_AFTER_HOURS * 3600 * 1000);
  const rows = await db
    .select({
      id: notifications.id,
      userId: notifications.userId,
      categoryId: notifications.categoryId,
      title: notifications.title,
      message: notifications.message,
      createdAt: notifications.createdAt,
      eventId: notifications.eventId,
      tenantName: tenants.name,
      tenantScoped: sql<boolean>`(${notifications.tenantId} is not null)`,
    })
    .from(notifications)
    // Inner: a copy whose recipient is gone can never be read, so it is not chased.
    .innerJoin(users, eq(users.id, notifications.userId))
    .leftJoin(tenants, eq(tenants.id, notifications.tenantId))
    .where(and(
      // An admin's own. Never a tenant user's: see "Whose" above.
      eq(users.panel, 'admin'),
      eq(notifications.isRead, 0),
      isNull(notifications.escalatedAt),
      lt(notifications.createdAt, cutoff),
      inArray(notifications.categoryId, [...ESCALATABLE]),
      // Nor one about a tenant that no longer exists.
      or(isNull(notifications.tenantId), isNotNull(tenants.id)),
      sql`not exists (select 1 from notifications read_copy
        where read_copy.event_id = ${notifications.eventId} and read_copy.is_read = 1)`,
    ))
    .orderBy(asc(notifications.createdAt), asc(notifications.id))
    .limit(limit);
  return rows as EscalationCandidate[];
}

/** One event, however many recipients' copies of it are unread. */
function eventKey(c: EscalationCandidate): string {
  return c.eventId ?? c.id;
}

/** How many notifications — events, not recipient copies — the batch holds. */
export function countEvents(candidates: readonly EscalationCandidate[]): number {
  return new Set(candidates.map(eventKey)).size;
}

/**
 * Mark candidates escalated.
 *
 * Called AFTER the escalation notification is dispatched, never before: if the
 * dispatch fails, the row stays eligible and the next tick retries. Marking
 * first would silently drop the escalation, which is the failure this whole
 * overhaul exists to remove.
 */
export async function markEscalated(
  db: Database,
  candidates: readonly EscalationCandidate[],
  now: Date = new Date(),
): Promise<void> {
  if (candidates.length === 0) return;
  const ids = candidates.map((c) => c.id);
  // Every copy of each event, not only those in the batch: the row limit can
  // cut between two admins' copies, and the one left behind would be
  // reported again next hour as if it were new.
  const eventIds = [...new Set(candidates.flatMap((c) => (c.eventId ? [c.eventId] : [])))];
  await db
    .update(notifications)
    .set({ escalatedAt: now })
    // inArray, NOT sql`id = ANY(${ids})`.
    //
    // Drizzle expands a JS array in a template literal into individual
    // placeholders, so that produced `ANY(($2, $3, … $32))` — a row
    // CONSTRUCTOR, which Postgres rejects. Caught on DEV, not in review or by
    // a unit test: the mock DB accepted the call happily, the scheduler threw
    // every tick, and `admin.notification_escalated` fired twice while
    // escalated_at stayed NULL on every row. An escalation that cannot mark
    // itself done re-fires forever, which is precisely the noise the
    // escalated_at column exists to prevent.
    .where(and(
      isNull(notifications.escalatedAt),
      eventIds.length > 0
        ? or(inArray(notifications.id, ids), inArray(notifications.eventId, eventIds))
        : inArray(notifications.id, ids),
    ));
}

/** Longest quote of the original message per item; whole items are capped by count. */
const MAX_DETAIL_CHARS = 400;

/**
 * The original message on one line: its own list lines ("• a@b (44 sent)")
 * joined with commas after the sentence that introduced them.
 */
export function oneLine(message: string): string {
  let out = '';
  let previousWasItem = false;
  for (const raw of message.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const isItem = line.startsWith('• ');
    const text = isItem ? line.slice(2).trim() : line;
    out = out === '' ? text : `${out}${isItem && previousWasItem ? ', ' : ' '}${text}`;
    previousWasItem = isItem;
  }
  if (out.length <= MAX_DETAIL_CHARS) return out;
  const cut = out.slice(0, MAX_DETAIL_CHARS - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX_DETAIL_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Whether any item concerns a tenant — which keeps the reminder off broadcast channels. */
export function concernsTenants(candidates: readonly EscalationCandidate[]): boolean {
  return candidates.some((c) => c.tenantScoped);
}

/**
 * One line per (title, tenant): what it was, which tenant it is about, how
 * long it has been unread, and what it said.
 *
 * Grouped, because the first real escalation on DEV listed the SAME SLO
 * warning six times — the reminder reproduced the repetition it exists to cut
 * through. Grouped per TENANT as well as title, because "Pod OOM-killed x3"
 * across three tenants names none of them.
 *
 * What it said is the newest copy's message, because that is where the
 * subject lives: the node, the workload, the backup target. The title alone
 * often does not name it — production's reminder "Email sending at 88% of the
 * hour limit" named no tenant and no mailbox.
 */
export function describeCandidates(candidates: readonly EscalationCandidate[]): string[] {
  const groups = new Map<string, { title: string; tenantName: string | null; events: Set<string>; oldest: Date; newest: EscalationCandidate }>();
  for (const c of candidates) {
    const key = `${c.tenantName ?? ''}\u0000${c.title}`;
    const seen = groups.get(key);
    if (seen) {
      seen.events.add(eventKey(c));
      if (c.createdAt < seen.oldest) seen.oldest = c.createdAt;
      if (c.createdAt > seen.newest.createdAt) seen.newest = c;
    } else {
      groups.set(key, { title: c.title, tenantName: c.tenantName, events: new Set([eventKey(c)]), oldest: c.createdAt, newest: c });
    }
  }
  // Most-repeated first: the loudest unhandled thing is the one to act on.
  // Counted in events: two admins' copies of one notification are one thing.
  const lines = [...groups.values()]
    .sort((a, b) => b.events.size - a.events.size)
    .map(({ title, tenantName, events, oldest, newest }) => {
      const n = events.size;
      const day = oldest.toISOString().slice(0, 10);
      const what = `${title}${n === 1 ? '' : ` x${n}`}${tenantName === null ? '' : ` (tenant ${tenantName})`}`;
      const head = n === 1 ? `${what} — unread since ${day}` : `${what} — oldest unread since ${day}`;
      const detail = oneLine(newest.message);
      if (detail === '' || detail === title) return `${head}.`;
      return `${head}. ${n === 1 ? 'It said' : 'The latest said'}: ${detail}`;
    });
  // One list item per group (rendered as a list on every channel), capped by count.
  return cappedList(lines);
}

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
 * Where it goes
 * -------------
 * A tenant-facing action that goes unread escalates to the PLATFORM ADMIN:
 * the operator is the party who can act when the customer has not. An
 * admin-facing action escalates to the operator's push channel, which is the
 * one route that reaches them away from the panel.
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
  /** Which panel the recipient reads it in — whose notification it is. */
  readonly recipientPanel: 'admin' | 'tenant';
  /**
   * The tenant it concerns: the tenant user's own, or the one an admin's copy
   * is about. Null for a platform admin's copy about no tenant.
   *
   * Every reminder production sent in its first month was about a TENANT's
   * notification, and none said which tenant — "Email sending at 88% of the
   * hour limit" reached the operator with no tenant, no mailbox, and nothing
   * in their own bell or history to look it up by.
   */
  readonly tenantName: string | null;
  /**
   * Its text is a tenant's (a tenant user's notification, or an admin's about
   * one). Read from the row, not from the tenant name, so it cannot read false
   * for tenant text that happens to have no name beside it.
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
 * Unread, never-escalated, escalatable notifications past the deadline that
 * NOBODY they were sent to has read, oldest first.
 *
 * The category filter is in SQL. It used to run after the query, so the 200
 * rows the query returned included unread Ambient and Record rows — which are
 * never marked escalated and so came back on every tick, and once there were
 * 200 of them no Action row would ever have been seen again.
 *
 * "Nobody read it": one event writes a row per recipient (every platform
 * admin; every user of a tenant). When one of them has read it, it was seen,
 * and chasing the others' copies is exactly the reminder "mark all as read"
 * cannot stop.
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
      recipientPanel: users.panel,
      tenantName: tenants.name,
      tenantScoped: sql<boolean>`(${notifications.tenantId} is not null or ${users.panel} <> 'admin')`,
    })
    .from(notifications)
    // Inner: a copy whose recipient is gone can never be read, so it is not chased.
    .innerJoin(users, eq(users.id, notifications.userId))
    .leftJoin(tenants, eq(tenants.id, sql`coalesce(${notifications.tenantId}, ${users.tenantId})`))
    .where(and(
      eq(notifications.isRead, 0),
      isNull(notifications.escalatedAt),
      lt(notifications.createdAt, cutoff),
      inArray(notifications.categoryId, [...ESCALATABLE]),
      // Nor is one about a tenant that no longer exists.
      or(isNull(sql`coalesce(${notifications.tenantId}, ${users.tenantId})`), isNotNull(tenants.id)),
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
  // cut between two recipients' copies, and the one left behind would be
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

/** Whether any item is a tenant's — which keeps the reminder off broadcast channels. */
export function concernsTenants(candidates: readonly EscalationCandidate[]): boolean {
  return candidates.some((c) => c.tenantScoped);
}

/** Whose notification it is, in the words the operator reads. */
function recipientLabel(c: EscalationCandidate): string {
  if (c.recipientPanel === 'tenant') return `Tenant ${c.tenantName ?? '(unnamed)'}`;
  return c.tenantName === null ? 'Platform admins' : `Platform admins, about tenant ${c.tenantName}`;
}

/**
 * One line per (recipient, title): who received it, what it was, how long it
 * has been unread, and what it said.
 *
 * Grouped, because the first real escalation on DEV listed the SAME SLO
 * warning six times — the reminder reproduced the repetition it exists to cut
 * through. Grouped per RECIPIENT as well as title, because "Subscription
 * expiring soon x3" across three tenants names none of them.
 *
 * What it said is the newest copy's message, because that is where the
 * subject lives: the mailbox that is full, the accounts that were sending, the
 * task that failed. The title alone never named it.
 */
export function describeCandidates(candidates: readonly EscalationCandidate[]): string[] {
  const groups = new Map<string, { who: string; title: string; events: Set<string>; oldest: Date; newest: EscalationCandidate }>();
  for (const c of candidates) {
    const who = recipientLabel(c);
    const key = `${who}\u0000${c.title}`;
    const seen = groups.get(key);
    if (seen) {
      seen.events.add(eventKey(c));
      if (c.createdAt < seen.oldest) seen.oldest = c.createdAt;
      if (c.createdAt > seen.newest.createdAt) seen.newest = c;
    } else {
      groups.set(key, { who, title: c.title, events: new Set([eventKey(c)]), oldest: c.createdAt, newest: c });
    }
  }
  // Most-repeated first: the loudest unhandled thing is the one to act on.
  // Counted in events: two admins' copies of one notification are one thing.
  const lines = [...groups.values()]
    .sort((a, b) => b.events.size - a.events.size)
    .map(({ who, title, events, oldest, newest }) => {
      const n = events.size;
      const day = oldest.toISOString().slice(0, 10);
      const head = n === 1
        ? `${who}: ${title} — unread since ${day}`
        : `${who}: ${title} x${n} — oldest unread since ${day}`;
      const detail = oneLine(newest.message);
      if (detail === '' || detail === title) return `${head}.`;
      return `${head}. ${n === 1 ? 'It said' : 'The latest said'}: ${detail}`;
    });
  // One list item per group (rendered as a list on every channel), capped by count.
  return cappedList(lines);
}

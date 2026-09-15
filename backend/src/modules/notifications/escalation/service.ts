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
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { notifications } from '../../../db/schema.js';
import { categoryMeta } from '../routing/effective-channels.js';
import type { Database } from '../../../db/index.js';

/** How long an action may sit unread before the operator is told. */
export const ESCALATE_AFTER_HOURS = 48;

export interface EscalationCandidate {
  readonly id: string;
  readonly userId: string;
  readonly categoryId: string | null;
  readonly title: string;
  readonly message: string;
  readonly createdAt: Date;
}

/**
 * Is this category one that escalating makes sense for?
 *
 * Action only. Deliberately reads the class rather than the severity: an
 * `info`-severity action (a subscription expiring in five weeks) still needs
 * chasing, and a `critical`-severity incident does not, because it already
 * went everywhere on the first attempt.
 */
export function isEscalatable(categoryId: string | null | undefined): boolean {
  if (!categoryId) return false;
  const meta = categoryMeta(categoryId);
  return meta?.cls === 'action';
}

/**
 * Unread, never-escalated notifications past the deadline.
 *
 * Returns candidates across every category; the caller filters with
 * {@link isEscalatable}. Filtering in SQL would mean duplicating the class
 * table into the query, which is exactly the kind of second source of truth
 * this overhaul removed elsewhere.
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
    })
    .from(notifications)
    .where(and(
      eq(notifications.isRead, 0),
      isNull(notifications.escalatedAt),
      lt(notifications.createdAt, cutoff),
    ))
    .limit(limit);
  return rows.filter((r) => isEscalatable(r.categoryId)) as EscalationCandidate[];
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
  ids: readonly string[],
  now: Date = new Date(),
): Promise<void> {
  if (ids.length === 0) return;
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
    .where(inArray(notifications.id, [...ids]));
}

/** Human summary for the escalation body. */
export function describeCandidates(candidates: readonly EscalationCandidate[]): string {
  return candidates
    .map((c) => `${c.title} (unread since ${c.createdAt.toISOString().slice(0, 10)})`)
    .join('; ')
    .slice(0, 2000);
}

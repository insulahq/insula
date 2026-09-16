/**
 * Per-object notification mutes.
 *
 * "Quiet about THIS one thing until Friday."
 *
 * Before this, the only tool during a known incident was muting the whole
 * category — which silences every other object it covers, and which nobody
 * remembers to turn back on. That is how a platform ends up with a category
 * that has been off for a year and an operator who is sure they are being
 * told about node health.
 *
 * Two deliberate constraints:
 *   - expiry is MANDATORY. An indefinite mute is the permanent silence this
 *     exists to prevent, arrived at one "temporarily" at a time.
 *   - Incident, Availability and Security classes are never mutable. The same
 *     rule that lets them through quiet hours applies here: if it can wait for
 *     a mute to expire, it was not one of those classes.
 */
import { and, eq, gt, lt, or, isNull, sql } from 'drizzle-orm';
import { notificationObjectMutes } from '../../../db/schema.js';
import { categoryMeta } from '../routing/effective-channels.js';
import { CLASS_POLICY } from '../routing/classes.js';
import type { Database } from '../../../db/index.js';

/** Longest a mute may last. Anything more is a category toggle in disguise. */
export const MAX_MUTE_DAYS = 30;

export interface MuteInput {
  /** NULL mutes the object across every category that names it. */
  readonly categoryId?: string | null;
  readonly objectKey: string;
  readonly days: number;
  readonly reason?: string | null;
  readonly createdBy?: string | null;
}

export class MuteRejected extends Error {}

/**
 * A class that bypasses quiet hours cannot be muted either.
 *
 * Exported so the API layer can reject with a useful message rather than
 * silently accepting a mute that the dispatcher will then ignore — a mute that
 * appears to work and does not is worse than a refusal.
 */
export function isMutableCategory(categoryId: string | null | undefined): boolean {
  if (!categoryId) return true;
  const meta = categoryMeta(categoryId);
  if (!meta) return true;
  return !CLASS_POLICY[meta.cls].mandatory;
}

export async function createMute(db: Database, input: MuteInput): Promise<void> {
  if (input.days <= 0 || input.days > MAX_MUTE_DAYS) {
    throw new MuteRejected(`mute duration must be between 1 and ${MAX_MUTE_DAYS} days`);
  }
  if (!isMutableCategory(input.categoryId)) {
    throw new MuteRejected(
      `${input.categoryId} is mandatory (incident, availability or security) and cannot be muted`,
    );
  }
  const mutedUntil = new Date(Date.now() + input.days * 86_400_000);
  // Re-muting EXTENDS rather than accumulating rows — otherwise the table
  // grows once per click and the lookup has to pick a winner.
  await db.execute(sql`
    INSERT INTO notification_object_mutes (id, category_id, object_key, muted_until, reason, created_by)
    VALUES (${crypto.randomUUID()}, ${input.categoryId ?? null}, ${input.objectKey},
            ${mutedUntil.toISOString()}, ${input.reason ?? null}, ${input.createdBy ?? null})
    ON CONFLICT (COALESCE(category_id, ''), object_key) DO UPDATE
      SET muted_until = EXCLUDED.muted_until,
          reason = EXCLUDED.reason,
          created_by = EXCLUDED.created_by
  `);
}

export async function removeMute(
  db: Database,
  categoryId: string | null,
  objectKey: string,
): Promise<void> {
  await db.delete(notificationObjectMutes).where(
    and(
      eq(notificationObjectMutes.objectKey, objectKey),
      categoryId === null
        ? isNull(notificationObjectMutes.categoryId)
        : eq(notificationObjectMutes.categoryId, categoryId),
    ),
  );
}

/**
 * Is (category, object) muted right now?
 *
 * Matches a category-specific mute OR a category-wide one for the same object.
 * Never throws: a lookup failure must not stop a delivery — failing OPEN is
 * the right default for a feature whose whole purpose is suppression.
 */
export async function isObjectMuted(
  db: Database,
  categoryId: string,
  objectKey: string | null | undefined,
  now: Date = new Date(),
): Promise<boolean> {
  if (!objectKey) return false;
  try {
    const rows = await db
      .select({ id: notificationObjectMutes.id })
      .from(notificationObjectMutes)
      .where(and(
        eq(notificationObjectMutes.objectKey, objectKey),
        gt(notificationObjectMutes.mutedUntil, now),
        or(
          isNull(notificationObjectMutes.categoryId),
          eq(notificationObjectMutes.categoryId, categoryId),
        ),
      ))
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function listActiveMutes(db: Database, now: Date = new Date()) {
  return db
    .select()
    .from(notificationObjectMutes)
    .where(gt(notificationObjectMutes.mutedUntil, now));
}

/**
 * Bounded growth: an expired mute is dead weight the dispatcher never reads.
 * Wired into the notification retention pass.
 */
export async function purgeExpiredMutes(db: Database, now: Date = new Date()): Promise<number> {
  const rows = await db
    .delete(notificationObjectMutes)
    .where(lt(notificationObjectMutes.mutedUntil, now))
    .returning({ id: notificationObjectMutes.id });
  return rows.length;
}

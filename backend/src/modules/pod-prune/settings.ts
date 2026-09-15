/**
 * Auto-prune retention, stored in the platform_settings key/value table.
 *
 * A plain key/value row rather than a column: this is one integer with a
 * default, and a migration for it would be ceremony. Reads are tolerant —
 * a missing row, a blank value or anything unparseable falls back to the
 * default rather than disabling the sweep silently.
 */
import { eq } from 'drizzle-orm';
import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { DEFAULT_AUTO_PRUNE_DAYS, MAX_AUTO_PRUNE_DAYS } from '@insula/api-contracts';

export const AUTO_PRUNE_DAYS_KEY = 'dead_pod_auto_prune_days';

export async function getAutoPruneDays(db: Database): Promise<number> {
  const [row] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, AUTO_PRUNE_DAYS_KEY))
    .limit(1);

  return coerceAutoPruneDays(row?.value);
}

/**
 * Parse a stored value into a usable retention.
 *
 * Exported because the fallback behaviour is the part worth pinning: a corrupt
 * row must not quietly turn the sweep off (which looks identical to "working,
 * nothing to do") nor turn it into an aggressive 0-day sweep that deletes a
 * record the moment it dies.
 */
export function coerceAutoPruneDays(raw: string | null | undefined): number {
  if (raw === undefined || raw === null) return DEFAULT_AUTO_PRUNE_DAYS;
  const trimmed = raw.trim();
  if (trimmed === '') return DEFAULT_AUTO_PRUNE_DAYS;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > MAX_AUTO_PRUNE_DAYS) return DEFAULT_AUTO_PRUNE_DAYS;
  return n;
}

export async function setAutoPruneDays(db: Database, days: number): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key: AUTO_PRUNE_DAYS_KEY, value: String(days) })
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: { value: String(days) },
    });
}

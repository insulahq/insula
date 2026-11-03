/**
 * The archiving failure an operator was told about, so its end can be told too.
 *
 * Written only once a "WAL archiving failing" alert reached someone, cleared
 * once archiving works again. A failure that never alerted therefore never
 * sends "recovered" either. Stored as one JSON row in platform_settings, like
 * the circuit-breaker (no migration needed).
 */
import { eq } from 'drizzle-orm';
import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

export const ALERTED_FAILURE_KEY = 'wal_archive_alerted_failure';

export interface AlertedFailure {
  readonly clusterName: string;
  /** When archiving started failing (ISO-8601); names the failure in the dedupe keys. */
  readonly failingSince: string;
  /** When the alert went out (ISO-8601). */
  readonly alertedAt: string;
}

/** The alerted failure, or null when there is none or the row is unreadable. */
export async function readAlertedFailure(db: Database): Promise<AlertedFailure | null> {
  const [row] = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.key, ALERTED_FAILURE_KEY))
    .limit(1);
  return row?.value ? parseAlertedFailure(row.value) : null;
}

/** A stored row, or null when it is not one this module wrote. */
export function parseAlertedFailure(value: string): AlertedFailure | null {
  try {
    const parsed = JSON.parse(value) as Partial<AlertedFailure> | null;
    if (typeof parsed?.clusterName !== 'string' || typeof parsed.failingSince !== 'string') return null;
    return {
      clusterName: parsed.clusterName,
      failingSince: parsed.failingSince,
      alertedAt: typeof parsed.alertedAt === 'string' ? parsed.alertedAt : parsed.failingSince,
    };
  } catch {
    return null;
  }
}

export async function recordAlertedFailure(db: Database, failure: AlertedFailure): Promise<void> {
  const value = JSON.stringify(failure);
  await db
    .insert(platformSettings)
    .values({ key: ALERTED_FAILURE_KEY, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value } });
}

export async function clearAlertedFailure(db: Database): Promise<void> {
  await db.delete(platformSettings).where(eq(platformSettings.key, ALERTED_FAILURE_KEY));
}

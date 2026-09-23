/**
 * The platform's configured wall-clock zone (`system_settings.timezone`).
 *
 * One source of truth for "what time does an operator mean when they type
 * `30 3 * * *`". The same value is written into every CronJob's
 * `spec.timeZone`, so the platform-side firing engines must read schedules
 * through it or the two halves disagree — which they did: CronJobs fired in
 * the operator's zone while `backup_schedules` fired the identical string in
 * UTC, two hours apart on a UTC+2 cluster.
 *
 * Falls back to UTC and SAYS SO. A silent fallback would reintroduce exactly
 * the drift this exists to prevent, and a schedule quietly running two hours
 * off is the kind of thing nobody notices for months.
 */

import type { Database } from '../../db/index.js';
import { getSettings } from './service.js';

export async function resolvePlatformTimeZone(
  db: Database,
  log?: { warn: (obj: unknown, msg: string) => void },
): Promise<string> {
  try {
    const zone = (await getSettings(db)).timezone?.trim();
    if (zone) return zone;
    return 'UTC';
  } catch (err) {
    log?.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'platform timezone unreadable — reading schedules in UTC for this tick',
    );
    return 'UTC';
  }
}

import { and, isNotNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { mailDriftItems } from '../../db/schema.js';

/**
 * How long a resolved drift item stays in the Data Drift page's Resolved
 * History. The page lists exactly this window and the principals-sync tick
 * deletes what has aged out of it, so the label and the table agree.
 */
export const RESOLVED_DRIFT_RETENTION_DAYS = 30;

/** Delete drift items resolved longer ago than the retention window. Returns how many. */
export async function reapResolvedDriftItems(db: Database): Promise<number> {
  const deleted = await db
    .delete(mailDriftItems)
    .where(and(
      isNotNull(mailDriftItems.resolvedAt),
      lt(mailDriftItems.resolvedAt, sql`now() - make_interval(days => ${RESOLVED_DRIFT_RETENTION_DAYS})`),
    ))
    .returning({ id: mailDriftItems.id });
  return deleted.length;
}

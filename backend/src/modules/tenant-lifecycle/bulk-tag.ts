import { eq, desc } from 'drizzle-orm';
import { tenantLifecycleTransitions } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

/**
 * Find the most-recent transition row for `tenantId` and stamp
 * `bulkOpId` into its `detail` JSON. Returns the transition id or
 * null if none was found (the cascade may have errored before
 * dispatching, in which case the bulk caller still records this
 * tenant as failed without a transition).
 *
 * Used by bulk operations so the UI can fan out queries by bulkOpId
 * and pull every transition that participated in the same batch.
 */
export async function tagBulkOpOnLatestTransition(
  db: Database,
  tenantId: string,
  bulkOpId: string,
): Promise<string | null> {
  const [latest] = await db.select({
    id: tenantLifecycleTransitions.id,
    detail: tenantLifecycleTransitions.detail,
  })
    .from(tenantLifecycleTransitions)
    .where(eq(tenantLifecycleTransitions.tenantId, tenantId))
    .orderBy(desc(tenantLifecycleTransitions.startedAt))
    .limit(1);
  if (!latest) return null;

  const newDetail = { ...(latest.detail ?? {}), bulkOpId };
  await db.update(tenantLifecycleTransitions)
    .set({ detail: newDetail })
    .where(eq(tenantLifecycleTransitions.id, latest.id));
  return latest.id;
}

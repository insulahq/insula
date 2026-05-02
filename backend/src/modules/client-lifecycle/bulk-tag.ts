import { eq, desc } from 'drizzle-orm';
import { clientLifecycleTransitions } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

/**
 * Find the most-recent transition row for `clientId` and stamp
 * `bulkOpId` into its `detail` JSON. Returns the transition id or
 * null if none was found (the cascade may have errored before
 * dispatching, in which case the bulk caller still records this
 * client as failed without a transition).
 *
 * Used by bulk operations so the UI can fan out queries by bulkOpId
 * and pull every transition that participated in the same batch.
 */
export async function tagBulkOpOnLatestTransition(
  db: Database,
  clientId: string,
  bulkOpId: string,
): Promise<string | null> {
  const [latest] = await db.select({
    id: clientLifecycleTransitions.id,
    detail: clientLifecycleTransitions.detail,
  })
    .from(clientLifecycleTransitions)
    .where(eq(clientLifecycleTransitions.clientId, clientId))
    .orderBy(desc(clientLifecycleTransitions.startedAt))
    .limit(1);
  if (!latest) return null;

  const newDetail = { ...(latest.detail ?? {}), bulkOpId };
  await db.update(clientLifecycleTransitions)
    .set({ detail: newDetail })
    .where(eq(clientLifecycleTransitions.id, latest.id));
  return latest.id;
}

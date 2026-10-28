/**
 * Read the facts the account banner's storage line is decided from
 * (`buildStorageNotice`). Separate from the pure builder so the builder is
 * tested without a database.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { StorageLifecycleState, StorageOperationType, TenantStorageNotice } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import { storageOperations, tenantWorkloadHealthEvents } from '../../db/schema.js';
import { buildStorageNotice } from './storage-notice.js';

export async function loadStorageNotice(
  db: Database,
  tenantId: string,
  state: StorageLifecycleState | null,
  activeOpType: StorageOperationType | null,
): Promise<TenantStorageNotice | null> {
  if (state !== 'failed') {
    return buildStorageNotice({ state, activeOpType, latestOpType: null, downWorkloads: [] });
  }
  // `failed` keeps no pointer to its operation (the pointer is released when
  // the operation ends), so the newest operation is the one that left it.
  const [latest] = await db
    .select({ opType: storageOperations.opType })
    .from(storageOperations)
    .where(eq(storageOperations.tenantId, tenantId))
    .orderBy(desc(storageOperations.createdAt))
    .limit(1);
  const latestOpType = latest?.opType ?? null;
  const down = latestOpType === 'autoheal'
    ? await db
      .select({ workload: tenantWorkloadHealthEvents.workload })
      .from(tenantWorkloadHealthEvents)
      .where(and(eq(tenantWorkloadHealthEvents.tenantId, tenantId), isNull(tenantWorkloadHealthEvents.clearedAt)))
    : [];
  return buildStorageNotice({
    state,
    activeOpType,
    latestOpType,
    downWorkloads: down.map((d) => d.workload),
  });
}

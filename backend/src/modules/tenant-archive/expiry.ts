/**
 * When an archive's final bundle reaches its expiry, the tenant goes with it
 * (operator decision): there is nothing left to restore it from, so it is
 * deleted through the normal delete — its bundles, its rows, its namespace.
 * An archive kept "with no end date" (no expiry) is never reached here.
 *
 * Called by the snapshot expiry sweep (storage-lifecycle expireSnapshots),
 * which runs on one replica, for an expired `pre-archive` snapshot row.
 */
import { and, desc, eq } from 'drizzle-orm';
import { storageSnapshots, tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { ApiError } from '../../shared/errors.js';

export type ExpiredArchiveOutcome =
  /** The tenant was deleted. */
  | 'deleted'
  /**
   * The snapshot does not hold the tenant's archive (any more): the tenant was
   * restored since, or archived again with a newer bundle. The expired bundle
   * expires as any other; the tenant is left alone.
   */
  | 'not-archived'
  /**
   * Not now: a restore is under way, the delete was refused, or the tenant is
   * kept out of automatic archive and delete — which no expiry overrides. The
   * bundle stays; the next sweep looks again.
   */
  | 'deferred';

interface Deps {
  readonly deleteTenant: (db: Database, id: string, k8s: K8sClients, snapshotId: string) => Promise<unknown>;
  readonly log: (msg: string) => void;
}

async function realDeps(): Promise<Deps> {
  const { deleteTenant } = await import('../tenants/service.js');
  return {
    deleteTenant: (db, id, k8s, snapshotId) => deleteTenant(db, id, k8s, { onlyIfArchiveExpired: snapshotId }),
    log: (msg) => console.log(`[tenant-archive] ${msg}`),
  };
}

/**
 * Whether the tenant is archived and `snapshotId` is its newest `pre-archive`
 * snapshot — the one its archive lives in. An older one is a previous archive
 * the tenant was restored from: its expiry must not delete the tenant.
 */
async function isCurrentArchive(db: Database, tenantId: string, snapshotId: string): Promise<{ archived: boolean; current: boolean; idle: boolean; keptOut: boolean; name: string }> {
  const [tenant] = await db
    .select({
      status: tenants.status,
      name: tenants.name,
      state: tenants.storageLifecycleState,
      opId: tenants.activeStorageOpId,
      exempt: tenants.lifecycleAutomationExempt,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) return { archived: false, current: false, idle: true, keptOut: false, name: '' };
  const [newest] = await db
    .select({ id: storageSnapshots.id })
    .from(storageSnapshots)
    .where(and(eq(storageSnapshots.tenantId, tenantId), eq(storageSnapshots.kind, 'pre-archive')))
    .orderBy(desc(storageSnapshots.createdAt), desc(storageSnapshots.id))
    .limit(1);
  return {
    archived: tenant.status === 'archived',
    current: newest?.id === snapshotId,
    idle: tenant.state === 'idle' && !tenant.opId,
    keptOut: tenant.exempt === true,
    name: tenant.name,
  };
}

/**
 * The delete's own check, made again under the tenant's lock (tenants/service
 * deleteTenant with `onlyIfArchiveExpired`): the sweep's read can be stale by
 * the time the lock is held — the operator may have started a restore.
 */
export async function assertArchiveExpiryStillDue(db: Database, tenantId: string, snapshotId: string): Promise<void> {
  const s = await isCurrentArchive(db, tenantId, snapshotId);
  if (!s.archived || !s.current) {
    throw new ApiError('NO_LONGER_DUE', 'The tenant is no longer archived from this bundle; it is not deleted', 409);
  }
  if (!s.idle) {
    throw new ApiError('STORAGE_OP_IN_PROGRESS', 'A storage operation owns this tenant; it is not deleted meanwhile', 409);
  }
  if (s.keptOut) {
    throw new ApiError('KEPT_OUT_OF_AUTOMATION', 'The tenant is kept out of automatic archive and delete; its expired archive does not delete it', 409);
  }
}

export async function deleteTenantOfExpiredArchive(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  snapshotId: string,
  deps?: Deps,
): Promise<ExpiredArchiveOutcome> {
  const d = deps ?? await realDeps();
  const s = await isCurrentArchive(db, tenantId, snapshotId);
  if (!s.archived || !s.current) return 'not-archived';
  if (!s.idle || s.keptOut) return 'deferred';
  try {
    await d.deleteTenant(db, tenantId, k8s, snapshotId);
    d.log(`deleted ${s.name} (${tenantId}): its archive expired`);
    return 'deleted';
  } catch (err) {
    if (err instanceof ApiError && err.code === 'NO_LONGER_DUE') return 'not-archived';
    d.log(`could not delete ${s.name} (${tenantId}) whose archive expired, trying again next sweep: ${err instanceof Error ? err.message : String(err)}`);
    return 'deferred';
  }
}

/**
 * The volume an archive left behind. Archives taken before archive removed
 * the volume itself left it Released — the tenant storage class keeps a
 * volume whose claim is deleted — with all the tenant's data, until the tenant
 * was deleted. Every archived tenant whose archive bundle is ready loses it
 * here: the bundle is what restore reads (it builds a fresh volume), so the
 * leftover only holds disk. A tenant a storage operation owns — a restore
 * writing its new volume — is skipped. Only Released volumes and Longhorn
 * volumes of the tenant's own namespace are touched (reapNamespaceVolumes).
 */
export async function reapArchivedTenantVolumes(db: Database, k8s: K8sClients): Promise<number> {
  const { and: andOp, eq: eqOp, isNull, like } = await import('drizzle-orm');
  const rows = await db
    .selectDistinct({ namespace: tenants.kubernetesNamespace })
    .from(tenants)
    .innerJoin(storageSnapshots, andOp(
      eqOp(storageSnapshots.tenantId, tenants.id),
      eqOp(storageSnapshots.kind, 'pre-archive'),
      eqOp(storageSnapshots.status, 'ready'),
      like(storageSnapshots.archivePath, 'bundle:%'),
    ))
    .where(andOp(
      eqOp(tenants.status, 'archived'),
      eqOp(tenants.storageLifecycleState, 'idle'),
      isNull(tenants.activeStorageOpId),
    ));
  if (rows.length === 0) return 0;
  const { reapNamespaceVolumes, realReapDeps } = await import('../tenant-lifecycle/reap-namespace-volumes.js');
  const deps = realReapDeps(k8s);
  let reaped = 0;
  for (const { namespace } of rows) {
    if (!namespace) continue;
    const r = await reapNamespaceVolumes(deps, namespace, { timeoutMs: 5_000 }).catch(() => null);
    reaped += r?.pvsReaped.length ?? 0;
  }
  return reaped;
}

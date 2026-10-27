/**
 * What an archived tenant's page shows: its archive bundle (date, size,
 * whether it holds everything), how long it is kept, whether it can be
 * restored from it — and what the restore dialog needs: the least size a
 * restored volume must have, the tenant's own size, the backup target the
 * archive sits on, the nodes it could come back on, and its subscription end.
 * Read from the newest `pre-archive` snapshot row — the only link from a
 * tenant to its archive bundle — and that bundle's row.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { TenantArchiveInfo } from '@insula/api-contracts';
import { backupComponents, backupConfigurations, backupJobs, storageSnapshots, tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { ApiError } from '../../shared/errors.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export interface ArchiveInfoDeps {
  /** For the nodes the tenant could come back on; without it `placement` is null. */
  readonly k8s?: K8sClients;
  /** The target tenant backups are bound to now (backup-source-shim/service.ts). */
  readonly boundTargetId?: () => Promise<string | null>;
}

export async function getTenantArchiveInfo(db: Database, tenantId: string, deps: ArchiveInfoDeps = {}): Promise<TenantArchiveInfo> {
  const [tenant] = await db.select({
    status: tenants.status,
    archivedAt: tenants.archivedAt,
    storageState: tenants.storageLifecycleState,
    nodeName: tenants.nodeName,
    storageTier: tenants.storageTier,
    storageLimitOverride: tenants.storageLimitOverride,
    planId: tenants.planId,
    subscriptionExpiresAt: tenants.subscriptionExpiresAt,
  }).from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) throw new ApiError('TENANT_NOT_FOUND', `Tenant ${tenantId} not found`, 404);

  const [snap] = await db.select().from(storageSnapshots)
    .where(and(eq(storageSnapshots.tenantId, tenantId), eq(storageSnapshots.kind, 'pre-archive')))
    .orderBy(desc(storageSnapshots.createdAt)).limit(1);
  const bundleId = snap?.archivePath?.startsWith('bundle:') ? snap.archivePath.slice('bundle:'.length) : null;
  const [job] = bundleId && bundleId !== 'pending'
    ? await db.select().from(backupJobs).where(eq(backupJobs.id, bundleId))
    : [];
  const sizes = job
    ? await db.select({ component: backupComponents.component, sizeBytes: backupComponents.sizeBytes }).from(backupComponents).where(eq(backupComponents.backupJobId, job.id))
    : [];

  const bundle = job
    ? {
        id: job.id,
        createdAt: (job.startedAt ?? job.createdAt).toISOString(),
        sizeBytes: sizes.reduce((sum, c) => sum + Number(c.sizeBytes ?? 0), 0) || Number(job.sizeBytes ?? 0),
        whole: job.systemTrigger === 'pre_archive',
      }
    : null;

  let notRestorableReason: string | null = null;
  if (tenant.status !== 'archived') notRestorableReason = 'The tenant is not archived.';
  else if (!snap || snap.status !== 'ready' || !bundle) notRestorableReason = 'There is no archive bundle to restore from: it never completed, or it has expired.';
  else if (job && job.status !== 'completed' && job.status !== 'partial') notRestorableReason = `The archive bundle is ${job.status}.`;
  // Every storage operation, restore included, refuses a tenant that is not idle.
  else if (tenant.storageState === 'failed') notRestorableReason = 'The last storage operation failed. Reset to idle, then restore.';
  else if (tenant.storageState && tenant.storageState !== 'idle') notRestorableReason = `A storage operation is running (${tenant.storageState}).`;

  return {
    archivedAt: iso(tenant.archivedAt),
    bundle,
    expiresAt: iso(snap?.expiresAt ?? null),
    restorable: notRestorableReason === null,
    notRestorableReason,
    filesBytes: Number(sizes.find((c) => c.component === 'files')?.sizeBytes ?? 0),
    storageGi: await storageGiOf(db, tenant),
    target: job?.targetConfigId ? await targetOf(db, job.targetConfigId, deps) : null,
    placement: deps.k8s ? await placementOf(db, deps.k8s, tenant) : null,
    subscriptionExpiresAt: iso(tenant.subscriptionExpiresAt),
  };
}

/** The tenant's size, as provisioning, its quota and the restore read it. */
async function storageGiOf(db: Database, tenant: { storageLimitOverride: string | null; planId: string }): Promise<number> {
  const { tenantStorageGi } = await import('../storage-lifecycle/service.js');
  return tenantStorageGi(db, tenant);
}

async function targetOf(db: Database, targetId: string, deps: ArchiveInfoDeps): Promise<TenantArchiveInfo['target']> {
  const [row] = await db.select({ id: backupConfigurations.id, name: backupConfigurations.name })
    .from(backupConfigurations).where(eq(backupConfigurations.id, targetId));
  if (!row) return null;
  let bound = true;
  try {
    bound = (await (deps.boundTargetId ?? defaultBoundTargetId(db))()) === targetId;
  } catch { /* unknown: say nothing about a source shim */ }
  return { id: row.id, name: row.name, bound };
}

function defaultBoundTargetId(db: Database): () => Promise<string | null> {
  return async () => {
    const key = process.env.PLATFORM_ENCRYPTION_KEY;
    if (!key) throw new Error('PLATFORM_ENCRYPTION_KEY not configured');
    const { boundTenantTargetId } = await import('../backup-source-shim/service.js');
    return boundTenantTargetId(db, key);
  };
}

async function placementOf(
  db: Database,
  k8s: K8sClients,
  tenant: { nodeName: string | null; storageTier: string | null },
): Promise<TenantArchiveInfo['placement']> {
  try {
    const { readRestorePlacement } = await import('./restore-placement.js');
    const placement = await readRestorePlacement(db, k8s, tenant);
    return { ...placement, nodes: [...placement.nodes] };
  } catch {
    // The cluster could not be read: the dialog offers the pin and Auto, and
    // the restore checks the node itself.
    return null;
  }
}

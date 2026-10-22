/**
 * What an archived tenant's page shows: its archive bundle (date, size,
 * whether it holds everything), how long it is kept, and whether it can be
 * restored from it. Read from the newest `pre-archive` snapshot row — the
 * only link from a tenant to its archive bundle — and that bundle's row.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { TenantArchiveInfo } from '@insula/api-contracts';
import { backupComponents, backupJobs, storageSnapshots, tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { ApiError } from '../../shared/errors.js';

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export async function getTenantArchiveInfo(db: Database, tenantId: string): Promise<TenantArchiveInfo> {
  const [tenant] = await db.select({
    status: tenants.status,
    archivedAt: tenants.archivedAt,
    storageState: tenants.storageLifecycleState,
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
    ? await db.select({ sizeBytes: backupComponents.sizeBytes }).from(backupComponents).where(eq(backupComponents.backupJobId, job.id))
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
  };
}

import { describe, it, expect, vi } from 'vitest';
import { backupComponents, backupConfigurations, backupJobs, storageSnapshots, tenants } from '../../db/schema.js';

vi.mock('../storage-lifecycle/service.js', () => ({
  tenantStorageGi: async (_db: unknown, t: { storageLimitOverride: string | null }) => Number(t.storageLimitOverride ?? 0) || 5,
}));

const { getTenantArchiveInfo } = await import('./info.js');

/** What an archived tenant's page shows: its bundle, its expiry, and the way back. */

/** A database that answers each read by the table it reads. */
function db(tenant: unknown, snap: unknown, job: unknown, components: unknown[] = [], target: unknown = null) {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === tenants) return tenant ? [tenant] : [];
    if (table === storageSnapshots) return snap ? [snap] : [];
    if (table === backupJobs) return job ? [job] : [];
    if (table === backupComponents) return components;
    if (table === backupConfigurations) return target ? [target] : [];
    return [];
  };
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows = rowsFor(table);
          return Object.assign(Promise.resolve(rows), { orderBy: () => ({ limit: async () => rows }) });
        },
      }),
    }),
  } as never;
}

const archivedAt = new Date('2026-10-20T10:00:00Z');
const snap = (over: Record<string, unknown> = {}) => ({ status: 'ready', archivePath: 'bundle:bkp-1', expiresAt: new Date('2027-01-18T10:00:00Z'), ...over });
const job = (over: Record<string, unknown> = {}) => ({ id: 'bkp-1', status: 'completed', systemTrigger: 'pre_archive', sizeBytes: 0, startedAt: archivedAt, createdAt: archivedAt, ...over });

describe('getTenantArchiveInfo', () => {
  it('a whole archive: date, size (all components), expiry, restorable', async () => {
    const info = await getTenantArchiveInfo(
      db({ status: 'archived', archivedAt, storageLimitOverride: '0.5', subscriptionExpiresAt: null }, snap(), job(), [{ component: 'files', sizeBytes: 100 }, { component: 'mailboxes', sizeBytes: 23 }]),
      't1',
    );
    expect(info).toEqual({
      archivedAt: archivedAt.toISOString(),
      bundle: { id: 'bkp-1', createdAt: archivedAt.toISOString(), sizeBytes: 123, whole: true },
      expiresAt: '2027-01-18T10:00:00.000Z',
      restorable: true,
      notRestorableReason: null,
      filesBytes: 100,
      storageGi: 0.5,
      target: null,
      placement: null,
      subscriptionExpiresAt: null,
    });
  });

  it('names the target the archive is on, and whether tenant backups are bound to it now', async () => {
    const tgt = { id: 'tgt-old', name: 'Old S3' };
    const onOld = await getTenantArchiveInfo(
      db({ status: 'archived', archivedAt }, snap(), job({ targetConfigId: 'tgt-old' }), [], tgt),
      't1', { boundTargetId: async () => 'tgt-new' },
    );
    expect(onOld.target).toEqual({ id: 'tgt-old', name: 'Old S3', bound: false });
    const onBound = await getTenantArchiveInfo(
      db({ status: 'archived', archivedAt }, snap(), job({ targetConfigId: 'tgt-old' }), [], tgt),
      't1', { boundTargetId: async () => 'tgt-old' },
    );
    expect(onBound.target?.bound).toBe(true);
  });

  it('says the subscription end, for the restore dialog', async () => {
    const end = new Date('2026-09-30T00:00:00Z');
    const info = await getTenantArchiveInfo(db({ status: 'archived', archivedAt, subscriptionExpiresAt: end }, snap(), job()), 't1');
    expect(info.subscriptionExpiresAt).toBe(end.toISOString());
  });

  it('kept with no end date', async () => {
    const info = await getTenantArchiveInfo(db({ status: 'archived', archivedAt }, snap({ expiresAt: null }), job()), 't1');
    expect(info.expiresAt).toBeNull();
  });

  it('an archive from before: files only', async () => {
    const info = await getTenantArchiveInfo(db({ status: 'archived', archivedAt }, snap(), job({ systemTrigger: 'pre_resize' })), 't1');
    expect(info.bundle?.whole).toBe(false);
    expect(info.restorable).toBe(true);
  });

  it('no bundle to restore from — it never completed, or it expired', async () => {
    const info = await getTenantArchiveInfo(db({ status: 'archived', archivedAt }, snap({ status: 'failed', archivePath: 'bundle:pending' }), null), 't1');
    expect(info).toMatchObject({ bundle: null, restorable: false, notRestorableReason: expect.stringContaining('no archive bundle') });
  });

  it('a restore that failed left the tenant failed: not restorable until it is reset to idle', async () => {
    const info = await getTenantArchiveInfo(db({ status: 'archived', archivedAt, storageState: 'failed' }, snap(), job()), 't1');
    expect(info).toMatchObject({ restorable: false, notRestorableReason: expect.stringContaining('Reset to idle') });
    expect(info.bundle?.id).toBe('bkp-1');
  });

  it('a storage operation running: not restorable while it runs', async () => {
    const info = await getTenantArchiveInfo(db({ status: 'archived', archivedAt, storageState: 'restoring' }, snap(), job()), 't1');
    expect(info).toMatchObject({ restorable: false, notRestorableReason: expect.stringContaining('restoring') });
  });

  it('no bundle says so before the storage state: a reset would not help', async () => {
    const info = await getTenantArchiveInfo(db({ status: 'archived', archivedAt, storageState: 'failed' }, snap({ status: 'failed', archivePath: 'bundle:pending' }), null), 't1');
    expect(info.notRestorableReason).toContain('no archive bundle');
  });

  it('a storage state not read: restorable on the bundle alone', async () => {
    const info = await getTenantArchiveInfo(db({ status: 'archived', archivedAt, storageState: null }, snap(), job()), 't1');
    expect(info.restorable).toBe(true);
  });

  it('idle: restorable', async () => {
    const info = await getTenantArchiveInfo(db({ status: 'archived', archivedAt, storageState: 'idle' }, snap(), job()), 't1');
    expect(info.restorable).toBe(true);
  });

  it('refuses a tenant that does not exist', async () => {
    await expect(getTenantArchiveInfo(db(null, null, null), 't1')).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND' });
  });
});

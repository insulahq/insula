import { describe, it, expect } from 'vitest';
import { getTenantArchiveInfo } from './info.js';

/** What an archived tenant's page shows: its bundle, its expiry, and the way back. */

function db(tenant: unknown, snap: unknown, job: unknown, components: unknown[] = []) {
  let call = 0;
  const next = () => {
    call += 1;
    if (call === 1) return tenant ? [tenant] : [];
    if (call === 2) return snap ? [snap] : [];
    if (call === 3) return job ? [job] : [];
    return components;
  };
  return {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = next();
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
    const info = await getTenantArchiveInfo(db({ status: 'archived', archivedAt }, snap(), job(), [{ sizeBytes: 100 }, { sizeBytes: 23 }]), 't1');
    expect(info).toEqual({
      archivedAt: archivedAt.toISOString(),
      bundle: { id: 'bkp-1', createdAt: archivedAt.toISOString(), sizeBytes: 123, whole: true },
      expiresAt: '2027-01-18T10:00:00.000Z',
      restorable: true,
      notRestorableReason: null,
    });
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

  it('refuses a tenant that does not exist', async () => {
    await expect(getTenantArchiveInfo(db(null, null, null), 't1')).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND' });
  });
});

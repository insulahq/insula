import { describe, it, expect, vi } from 'vitest';
import { assertArchiveExpiryStillDue, deleteTenantOfExpiredArchive } from './expiry.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { ApiError } from '../../shared/errors.js';

/** An archive that expires takes its tenant with it — nothing is left to restore from. */

interface Tenant { status: string; name: string; state?: string; opId?: string | null; exempt?: boolean }

/** The tenant row first, then the tenant's newest pre-archive snapshot. */
const dbWith = (tenant: Tenant | null, newestSnapshotId: string | null = 'snap-1'): Database => ({
  select: () => ({
    from: () => ({
      where: () => {
        const tenantRows = tenant ? [{ state: 'idle', opId: null, exempt: false, ...tenant }] : [];
        const snapshotRows = newestSnapshotId ? [{ id: newestSnapshotId }] : [];
        return Object.assign(Promise.resolve(tenantRows), {
          orderBy: () => ({ limit: async () => snapshotRows }),
        });
      },
    }),
  }),
}) as unknown as Database;
const k8s = {} as K8sClients;
const deps = (impl: () => Promise<unknown> = async () => ({})) => ({ deleteTenant: vi.fn(impl), log: vi.fn() });

describe('deleteTenantOfExpiredArchive', () => {
  it('deletes a tenant still archived from the expired bundle, re-checked under its lock', async () => {
    const d = deps();
    expect(await deleteTenantOfExpiredArchive(dbWith({ status: 'archived', name: 'Acme' }), k8s, 't1', 'snap-1', d)).toBe('deleted');
    expect(d.deleteTenant).toHaveBeenCalledWith(expect.anything(), 't1', k8s, 'snap-1');
  });

  it('leaves a tenant restored since alone: its old archive bundle expires as any bundle', async () => {
    const d = deps();
    expect(await deleteTenantOfExpiredArchive(dbWith({ status: 'active', name: 'Acme' }), k8s, 't1', 'snap-1', d)).toBe('not-archived');
    expect(d.deleteTenant).not.toHaveBeenCalled();
  });

  it('leaves a tenant restored and archived again alone when its OLD archive expires', async () => {
    // Archived (snap-1, 30 days), restored, archived again (snap-2, never
    // expires): snap-1 reaching its date must not delete the tenant.
    const d = deps();
    expect(await deleteTenantOfExpiredArchive(dbWith({ status: 'archived', name: 'Acme' }, 'snap-2'), k8s, 't1', 'snap-1', d)).toBe('not-archived');
    expect(d.deleteTenant).not.toHaveBeenCalled();
  });

  it('waits while a storage operation (a restore) owns the tenant', async () => {
    const d = deps();
    const db = dbWith({ status: 'archived', name: 'Acme', state: 'restoring', opId: 'op-1' });
    expect(await deleteTenantOfExpiredArchive(db, k8s, 't1', 'snap-1', d)).toBe('deferred');
    expect(d.deleteTenant).not.toHaveBeenCalled();
  });

  it('never deletes a tenant kept out of automatic archive and delete: the archive waits, bundle and all', async () => {
    const d = deps();
    const db = dbWith({ status: 'archived', name: 'Acme', exempt: true });
    expect(await deleteTenantOfExpiredArchive(db, k8s, 't1', 'snap-1', d)).toBe('deferred');
    expect(d.deleteTenant).not.toHaveBeenCalled();
    await expect(assertArchiveExpiryStillDue(db, 't1', 'snap-1')).rejects.toMatchObject({ code: 'KEPT_OUT_OF_AUTOMATION' });
  });

  it('a refused delete (the tenant is busy) is tried again by the next sweep, not dropped', async () => {
    const d = deps(async () => { throw Object.assign(new Error('busy'), { code: 'TENANT_BUSY' }); });
    expect(await deleteTenantOfExpiredArchive(dbWith({ status: 'archived', name: 'Acme' }), k8s, 't1', 'snap-1', d)).toBe('deferred');
  });

  it('a delete refused under the lock as no longer due lets the bundle expire normally', async () => {
    const d = deps(async () => { throw new ApiError('NO_LONGER_DUE', 'restored meanwhile', 409); });
    expect(await deleteTenantOfExpiredArchive(dbWith({ status: 'archived', name: 'Acme' }), k8s, 't1', 'snap-1', d)).toBe('not-archived');
  });
});

describe('assertArchiveExpiryStillDue', () => {
  it('passes for the archived tenant\'s newest archive with nothing under way', async () => {
    await expect(assertArchiveExpiryStillDue(dbWith({ status: 'archived', name: 'Acme' }), 't1', 'snap-1')).resolves.toBeUndefined();
  });

  it('refuses NO_LONGER_DUE for an older archive or a restored tenant', async () => {
    await expect(assertArchiveExpiryStillDue(dbWith({ status: 'archived', name: 'Acme' }, 'snap-2'), 't1', 'snap-1'))
      .rejects.toMatchObject({ code: 'NO_LONGER_DUE' });
    await expect(assertArchiveExpiryStillDue(dbWith({ status: 'active', name: 'Acme' }), 't1', 'snap-1'))
      .rejects.toMatchObject({ code: 'NO_LONGER_DUE' });
  });

  it('refuses STORAGE_OP_IN_PROGRESS while a restore owns the tenant', async () => {
    await expect(assertArchiveExpiryStillDue(dbWith({ status: 'archived', name: 'Acme', state: 'restoring', opId: 'op-1' }), 't1', 'snap-1'))
      .rejects.toMatchObject({ code: 'STORAGE_OP_IN_PROGRESS' });
  });
});

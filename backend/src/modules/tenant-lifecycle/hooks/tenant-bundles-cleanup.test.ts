import { describe, it, expect, vi, beforeEach } from 'vitest';

// The hook RETAINS a deleted tenant's bundles (the retention reaper deletes
// them by expires_at); it must never purge the off-site store on delete. On
// delete it floors each reap-eligible bundle's expires_at to now + the admin-
// configured grace window (system_settings.deletedTenantBundleRetentionDays)
// — extend-never-shorten: backfill retain-forever (null) bundles, extend ones
// expiring sooner, and never shorten one already scheduled to live longer.
const { updateSetSpy, updateWhereSpy, getSettingsMock } = vi.hoisted(() => ({
  updateSetSpy: vi.fn(),
  updateWhereSpy: vi.fn(async () => undefined),
  getSettingsMock: vi.fn(async () => ({ deletedTenantBundleRetentionDays: 30 })),
}));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (col: { name?: string }, val: unknown) => ({ __testEq: true, col, val }),
  };
});

vi.mock('../../system-settings/service.js', () => ({
  getSettings: getSettingsMock,
}));

import { backupsV2BundleCleanupHook } from './tenant-bundles-cleanup.js';
import type { HookCtx } from '../registry/index.js';

type Job = { id: string; expiresAt: Date | null; status: string };
const DAY = 86_400_000;

function makeCtx(jobs: Job[]): HookCtx {
  return {
    db: {
      select: () => ({ from: () => ({ where: async () => jobs }) }),
      update: () => ({
        set: (v: unknown) => { updateSetSpy(v); return { where: updateWhereSpy }; },
      }),
    } as never,
    k8s: {} as never,
    tenantId: 'c1',
    namespace: 'tenant-test',
    transitionId: 't1',
    transition: 'deleted',
    attempt: 1,
  };
}

describe('tenant-bundles-bundle-cleanup hook (retain + floor grace window)', () => {
  beforeEach(() => {
    updateSetSpy.mockReset();
    updateWhereSpy.mockReset().mockResolvedValue(undefined);
    getSettingsMock.mockReset().mockResolvedValue({ deletedTenantBundleRetentionDays: 30 });
  });

  it('noop on non-deleted transitions', async () => {
    const ctx = { ...makeCtx([]), transition: 'suspended' as const };
    const r = await backupsV2BundleCleanupHook.run(ctx);
    expect(r.status).toBe('noop');
    expect(updateSetSpy).not.toHaveBeenCalled();
  });

  it('noop when tenant has no bundles', async () => {
    const r = await backupsV2BundleCleanupHook.run(makeCtx([]));
    expect(r.status).toBe('noop');
    expect(updateSetSpy).not.toHaveBeenCalled();
  });

  it('backfills expires_at on retain-forever (null) reap-eligible bundles', async () => {
    const before = Date.now();
    const r = await backupsV2BundleCleanupHook.run(makeCtx([
      { id: 'b-null', expiresAt: null, status: 'completed' },
    ]));
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('retained 1 bundle');
    expect(updateSetSpy).toHaveBeenCalledTimes(1);
    const exp = (updateSetSpy.mock.calls[0][0] as { expiresAt: Date }).expiresAt.getTime();
    expect(exp).toBeGreaterThan(before + 29 * DAY);
    expect(exp).toBeLessThan(before + 31 * DAY);
  });

  it('EXTENDS a bundle whose expiry is sooner than the grace window', async () => {
    const r = await backupsV2BundleCleanupHook.run(makeCtx([
      { id: 'b-soon', expiresAt: new Date(Date.now() + 5 * DAY), status: 'completed' },
    ]));
    expect(r.status).toBe('ok');
    expect(updateSetSpy).toHaveBeenCalledTimes(1);
  });

  it('NEVER shortens a bundle already scheduled to live longer', async () => {
    const r = await backupsV2BundleCleanupHook.run(makeCtx([
      { id: 'b-far', expiresAt: new Date(Date.now() + 60 * DAY), status: 'completed' },
    ]));
    expect(r.status).toBe('ok');
    expect(updateSetSpy).not.toHaveBeenCalled();
  });

  it('skips non-reap-eligible (running) bundles', async () => {
    const r = await backupsV2BundleCleanupHook.run(makeCtx([
      { id: 'b-run', expiresAt: null, status: 'running' },
    ]));
    expect(r.status).toBe('ok');
    expect(updateSetSpy).not.toHaveBeenCalled();
  });

  it('uses the admin-configured retention window (not the default)', async () => {
    getSettingsMock.mockResolvedValue({ deletedTenantBundleRetentionDays: 45 });
    const before = Date.now();
    await backupsV2BundleCleanupHook.run(makeCtx([
      { id: 'b-null', expiresAt: null, status: 'completed' },
    ]));
    expect(updateSetSpy).toHaveBeenCalledTimes(1);
    const exp = (updateSetSpy.mock.calls[0][0] as { expiresAt: Date }).expiresAt.getTime();
    expect(exp).toBeGreaterThan(before + 44 * DAY);
    expect(exp).toBeLessThan(before + 46 * DAY);
  });

  it('falls back to 30 days when the settings read fails', async () => {
    getSettingsMock.mockRejectedValue(new Error('db down'));
    const before = Date.now();
    await backupsV2BundleCleanupHook.run(makeCtx([
      { id: 'b-null', expiresAt: null, status: 'completed' },
    ]));
    expect(updateSetSpy).toHaveBeenCalledTimes(1);
    const exp = (updateSetSpy.mock.calls[0][0] as { expiresAt: Date }).expiresAt.getTime();
    expect(exp).toBeGreaterThan(before + 29 * DAY);
    expect(exp).toBeLessThan(before + 31 * DAY);
  });
});

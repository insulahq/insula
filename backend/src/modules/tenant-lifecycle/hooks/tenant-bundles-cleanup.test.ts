import { describe, it, expect, vi, beforeEach } from 'vitest';

// The hook RETAINS a deleted tenant's bundles (the retention reaper deletes them
// by expires_at); it must never purge the off-site store on delete. It only
// backfills an expires_at on reap-eligible bundles that lack one.
const { updateSetSpy, updateWhereSpy } = vi.hoisted(() => ({
  updateSetSpy: vi.fn(),
  updateWhereSpy: vi.fn(async () => undefined),
}));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (col: { name?: string }, val: unknown) => ({ __testEq: true, col, val }),
  };
});

import { backupsV2BundleCleanupHook } from './tenant-bundles-cleanup.js';
import type { HookCtx } from '../registry/index.js';

type Job = { id: string; expiresAt: Date | null; retentionDays: number; status: string };

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

describe('tenant-bundles-bundle-cleanup hook (retain, never purge)', () => {
  beforeEach(() => {
    updateSetSpy.mockReset();
    updateWhereSpy.mockReset().mockResolvedValue(undefined);
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

  it('RETAINS bundles (never purges) and returns ok', async () => {
    const r = await backupsV2BundleCleanupHook.run(makeCtx([
      { id: 'b1', expiresAt: new Date(), retentionDays: 30, status: 'completed' },
      { id: 'b2', expiresAt: new Date(), retentionDays: 30, status: 'completed' },
    ]));
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('retained 2 bundle');
    // Every bundle already had an expires_at → nothing backfilled, nothing purged.
    expect(updateSetSpy).not.toHaveBeenCalled();
  });

  it('backfills expires_at ONLY on reap-eligible bundles lacking one', async () => {
    const r = await backupsV2BundleCleanupHook.run(makeCtx([
      { id: 'b-null', expiresAt: null, retentionDays: 30, status: 'completed' },
      { id: 'b-has', expiresAt: new Date(), retentionDays: 30, status: 'completed' },
      { id: 'b-run', expiresAt: null, retentionDays: 30, status: 'running' }, // not reap-eligible
    ]));
    expect(r.status).toBe('ok');
    expect(updateSetSpy).toHaveBeenCalledTimes(1); // only b-null
    expect(updateSetSpy.mock.calls[0][0]).toHaveProperty('expiresAt');
    expect((updateSetSpy.mock.calls[0][0] as { expiresAt: Date }).expiresAt).toBeInstanceOf(Date);
    expect(r.detail).toContain('backfilled expires_at on 1');
  });

  it('defaults to 30-day retention when retentionDays is 0/unset', async () => {
    const before = Date.now();
    await backupsV2BundleCleanupHook.run(makeCtx([
      { id: 'b-null', expiresAt: null, retentionDays: 0, status: 'completed' },
    ]));
    expect(updateSetSpy).toHaveBeenCalledTimes(1);
    const exp = (updateSetSpy.mock.calls[0][0] as { expiresAt: Date }).expiresAt.getTime();
    // ~30 days out (allow a wide slack for test timing)
    expect(exp).toBeGreaterThan(before + 29 * 86_400_000);
    expect(exp).toBeLessThan(before + 31 * 86_400_000);
  });
});

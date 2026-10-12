import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../shared/errors.js';
import { archiveTenant } from './service.js';

/**
 * The automatic sweep's archive: its list of due tenants may be hours old by
 * the time it reaches one, so the archive checks again — under the tenant's
 * lock, before it claims anything — that this tenant is still suspended, and
 * has been for long enough.
 */

// The archive itself runs detached after the claim; it is not under test.
vi.mock('./quiesce.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  quiesce: vi.fn().mockRejectedValue(new Error('not under test')),
}));

const LIMIT = new Date('2026-03-01T00:00:00.000Z');

function attempt(tenant: Record<string, unknown>, onlyIfSuspendedBefore: Date | null = LIMIT) {
  // mustGetTenant reads the row, mustBeIdle its { state, opId } projection.
  const row = { id: 'c1', kubernetesNamespace: 'tenant-c1', state: 'idle', opId: null, ...tenant };
  const claims: unknown[] = [];
  const chain = () => ({
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve([row]).then(resolve, reject),
    limit: vi.fn().mockResolvedValue([row]),
    catch: vi.fn(),
  });
  const tx = {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockImplementation((v: unknown) => { claims.push(v); return { where: vi.fn().mockImplementation(chain) }; }) }),
  };
  const db = {
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockImplementation(chain) }) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockImplementation(chain) }) }),
    insert: tx.insert,
    transaction: vi.fn().mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx)),
    // The tenant's lock: always free here.
    execute: vi.fn().mockResolvedValue({ rows: [{ setting_key: 'lease' }] }),
  };
  const ctx = { db, k8s: { core: {}, apps: {}, batch: {}, custom: {} }, store: {}, platformNamespace: 'platform' } as unknown as Parameters<typeof archiveTenant>[0];
  return archiveTenant(ctx, 'c1', onlyIfSuspendedBefore ? { onlyIfSuspendedBefore } : {})
    .then((v) => ({ outcome: v as unknown, claims }), (err: unknown) => ({ outcome: err, claims }));
}

describe('archiveTenant, only if still suspended for long enough', () => {
  it.each([
    ['resumed since: active again', { status: 'active', suspendedAt: null }],
    ['suspended again since: not for long enough', { status: 'suspended', suspendedAt: new Date('2026-03-02') }],
    ['suspended exactly at the limit', { status: 'suspended', suspendedAt: LIMIT }],
    ['with no suspension date on record', { status: 'suspended', suspendedAt: null }],
  ])('refuses a tenant %s, and claims nothing', async (_why, tenant) => {
    const { outcome, claims } = await attempt(tenant);
    expect(outcome).toBeInstanceOf(ApiError);
    expect(outcome).toMatchObject({ code: 'NO_LONGER_DUE', status: 409 });
    expect(claims).toEqual([]);
  });

  it('archives a tenant still suspended since before the limit', async () => {
    const { outcome, claims } = await attempt({ status: 'suspended', suspendedAt: new Date('2026-02-28T23:59:59.000Z') });
    expect(outcome).toMatchObject({ operationId: expect.any(String), snapshotId: expect.any(String) });
    expect(claims).toEqual([expect.objectContaining({ storageLifecycleState: 'quiescing' })]);
  });

  it('refuses a tenant an admin has taken out of the automation since, and claims nothing', async () => {
    const { outcome, claims } = await attempt({ status: 'suspended', suspendedAt: new Date('2026-01-01'), lifecycleAutomationExempt: true });
    expect(outcome).toMatchObject({ code: 'NO_LONGER_DUE', status: 409 });
    expect((outcome as ApiError).message).toContain('kept out');
    expect(claims).toEqual([]);
  });

  it('an operator\'s own archive of a tenant kept out of the automation goes ahead: the flag is about the sweep', async () => {
    const { outcome, claims } = await attempt({ status: 'suspended', suspendedAt: new Date('2026-01-01'), lifecycleAutomationExempt: true }, null);
    expect(outcome).toMatchObject({ operationId: expect.any(String) });
    expect(claims).toHaveLength(1);
  });

  it('a tenant with an operation under way is refused as busy, whatever its dates', async () => {
    const { outcome, claims } = await attempt({ status: 'suspended', suspendedAt: new Date('2026-01-01'), state: 'restoring' });
    expect(outcome).toMatchObject({ code: 'STORAGE_OP_IN_PROGRESS' });
    expect(claims).toEqual([]);
  });

  it('an operator\'s archive asks none of this: an active tenant is archived', async () => {
    const { outcome, claims } = await attempt({ status: 'active', suspendedAt: null }, null);
    expect(outcome).toMatchObject({ operationId: expect.any(String) });
    expect(claims).toHaveLength(1);
  });
});

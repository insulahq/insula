import { describe, it, expect, vi, beforeEach } from 'vitest';

// The gate's two inputs — the platform-wide switch and the subscription —
// are mocked at their modules, so each test sets exactly what it is about.
const getSettingsMock = vi.fn();
vi.mock('../system-settings/service.js', () => ({
  getSettings: (...args: unknown[]) => getSettingsMock(...args),
}));
const allowedByPlanMock = vi.fn();
vi.mock('../subscriptions/service.js', () => ({
  isCustomContainersAllowedByPlan: (...args: unknown[]) => allowedByPlanMock(...args),
}));

const { createPrivateWorker, rotatePrivateWorker } = await import('./service.js');

/** A db whose every select answers `rows`; records whether anything was written. */
function fakeDb(rows: unknown[] = []) {
  const insert = vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) }));
  const update = vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) }));
  const select = vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue(rows) })) }));
  return { db: { select, insert, update } as never, select, insert, update };
}

const INPUT = { name: 'home-gpu' };

describe('createPrivateWorker — gated by "Allow Custom Containers"', () => {
  beforeEach(() => {
    getSettingsMock.mockReset().mockResolvedValue({ customDeploymentsEnabled: true });
    allowedByPlanMock.mockReset().mockResolvedValue(true);
  });

  it('refuses a tenant whose subscription does not allow custom containers, before reading or writing anything', async () => {
    allowedByPlanMock.mockResolvedValue(false);
    const { db, select, insert, update } = fakeDb();
    await expect(createPrivateWorker(db, 't1', INPUT, 'u1')).rejects.toMatchObject({
      code: 'CUSTOM_CONTAINERS_NOT_IN_PLAN',
      status: 403,
    });
    expect(allowedByPlanMock).toHaveBeenCalledWith(db, 't1');
    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses every tenant while custom deployments are disabled platform-wide, even one whose plan allows them', async () => {
    getSettingsMock.mockResolvedValue({ customDeploymentsEnabled: false });
    const { db, insert } = fakeDb();
    await expect(createPrivateWorker(db, 't1', INPUT, 'u1')).rejects.toMatchObject({
      code: 'CUSTOM_DEPLOYMENTS_DISABLED',
      status: 403,
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('lets an allowed tenant through to the create checks', async () => {
    // A row for the duplicate-name probe: reaching that 409 proves the gate passed.
    const { db } = fakeDb([{ id: 'existing' }]);
    await expect(createPrivateWorker(db, 't1', INPUT, 'u1')).rejects.toMatchObject({
      code: 'DUPLICATE_PRIVATE_WORKER_NAME',
    });
  });
});

describe('rotatePrivateWorker — an existing worker stays manageable', () => {
  it('is not gated: a tenant without custom containers still reaches the rotation', async () => {
    getSettingsMock.mockReset().mockResolvedValue({ customDeploymentsEnabled: false });
    allowedByPlanMock.mockReset().mockResolvedValue(false);
    // A revoked worker stops rotate at its own check — past any gate.
    const { db } = fakeDb([{ id: 'w1', tenantId: 't1', status: 'revoked' }]);
    await expect(rotatePrivateWorker(db, 't1', 'w1', 'u1')).rejects.toMatchObject({
      code: 'PRIVATE_WORKER_REVOKED',
    });
    expect(getSettingsMock).not.toHaveBeenCalled();
    expect(allowedByPlanMock).not.toHaveBeenCalled();
  });

  it('★ a revoke that lands after the read is not undone: no row updated → refused, shared secret untouched', async () => {
    // The read sees an active worker; the guarded UPDATE (status <> revoked) matches nothing.
    const tables: unknown[] = [];
    const update = vi.fn((table: unknown) => {
      tables.push(table);
      return { set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })) })) };
    });
    const select = vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ id: 'w1', tenantId: 't1', status: 'active' }]) })) }));
    const db = { select, update, insert: vi.fn() } as never;
    await expect(rotatePrivateWorker(db, 't1', 'w1', 'u1')).rejects.toMatchObject({ code: 'PRIVATE_WORKER_REVOKED' });
    const { privateWorkers } = await import('../../db/schema.js');
    expect(tables).toEqual([privateWorkers]);
  });
});

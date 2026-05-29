import { describe, it, expect, vi } from 'vitest';

// Phase 4: stub the notification helpers so the service tests don't
// cascade into the real dispatcher (which would consume db.select
// calls and break the carefully ordered fakes in this file).
const notifyChangedMock = vi.fn().mockResolvedValue(undefined);
const notifyRenewedMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../notifications/events.js', () => ({
  notifyTenantSubscriptionChanged: (...args: unknown[]) => notifyChangedMock(...args),
  notifyTenantSubscriptionRenewed: (...args: unknown[]) => notifyRenewedMock(...args),
}));

const { getSubscription, updateSubscription } = await import('./service.js');
const { ApiError } = await import('../../shared/errors.js');

function createMockDb(tenantResult: unknown[] = [], planResult: unknown[] = []) {
  let selectCallCount = 0;

  const whereFn = vi.fn().mockImplementation(() => {
    selectCallCount++;
    // First select: tenants table. Second select: hostingPlans table.
    if (selectCallCount % 2 === 1) return Promise.resolve(tenantResult);
    return Promise.resolve(planResult);
  });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  return {
    select: selectFn,
    update: updateFn,
    _updateFn: updateFn,
    _updateSet: updateSet,
  } as unknown as Parameters<typeof getSubscription>[0] & {
    _updateFn: ReturnType<typeof vi.fn>;
    _updateSet: ReturnType<typeof vi.fn>;
  };
}

describe('getSubscription', () => {
  it('should throw TENANT_NOT_FOUND when tenant missing', async () => {
    const db = createMockDb([], []);

    await expect(getSubscription(db, 'missing')).rejects.toThrow(ApiError);
    await expect(getSubscription(db, 'missing')).rejects.toMatchObject({
      code: 'TENANT_NOT_FOUND',
      status: 404,
    });
  });

  it('should return subscription with plan when found', async () => {
    const tenant = {
      id: 'c1',
      planId: 'p1',
      status: 'active',
      subscriptionExpiresAt: new Date('2027-01-01'),
      createdAt: new Date('2026-01-01'),
    };
    const plan = { id: 'p1', name: 'Basic', code: 'basic' };

    const db = createMockDb([tenant], [plan]);
    const result = await getSubscription(db, 'c1');

    expect(result.tenant_id).toBe('c1');
    expect(result.plan).toEqual(plan);
    expect(result.status).toBe('active');
  });

  it('should return null plan when no plan found', async () => {
    const tenant = {
      id: 'c1',
      planId: 'p1',
      status: 'active',
      subscriptionExpiresAt: null,
      createdAt: new Date('2026-01-01'),
    };

    const db = createMockDb([tenant], []);
    const result = await getSubscription(db, 'c1');

    expect(result.plan).toBeNull();
  });
});

describe('updateSubscription', () => {
  it('should throw TENANT_NOT_FOUND when tenant missing', async () => {
    const db = createMockDb([], []);

    await expect(updateSubscription(db, 'missing', { plan_id: 'p2' })).rejects.toMatchObject({
      code: 'TENANT_NOT_FOUND',
    });
  });

  it('should update plan_id', async () => {
    const tenant = {
      id: 'c1',
      name: 'Acme',
      planId: 'p1',
      status: 'active',
      subscriptionExpiresAt: null,
      createdAt: new Date('2026-01-01'),
    };
    const plan = { id: 'p2', name: 'Pro' };
    const oldPlan = { id: 'p1', name: 'Free' };

    // Phase 4: updateSubscription now also queries old + new plan
    // names for the subscription.changed notification payload before
    // the final getSubscription. Sequence:
    //   1. select tenant (pre-update snapshot)
    //   2. update
    //   3. select oldPlan
    //   4. select newPlan
    //   5. select tenant (getSubscription)
    //   6. select plan (getSubscription)
    let selectCallCount = 0;
    const results = [tenant, oldPlan, plan, tenant, plan];

    const whereFn = vi.fn().mockImplementation(() => {
      const result = results[selectCallCount] ?? [];
      selectCallCount++;
      return Promise.resolve([result]);
    });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const updateFn = vi.fn().mockReturnValue({ set: updateSet });

    const db = {
      select: selectFn,
      update: updateFn,
    } as unknown as Parameters<typeof getSubscription>[0];

    const result = await updateSubscription(db, 'c1', { plan_id: 'p2' });
    expect(result.tenant_id).toBe('c1');
    expect(updateFn).toHaveBeenCalled();
  });

  it('fires subscription.changed when plan_id changes', async () => {
    const tenant = { id: 'c1', name: 'Acme', planId: 'p1', status: 'active', subscriptionExpiresAt: null, createdAt: new Date('2026-01-01') };
    const oldPlan = { id: 'p1', name: 'Free' };
    const newPlan = { id: 'p2', name: 'Pro' };
    let i = 0;
    const results: unknown[] = [tenant, oldPlan, newPlan, tenant, newPlan];
    const whereFn = vi.fn().mockImplementation(() => Promise.resolve([results[i++]]));
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const updateFn = vi.fn().mockReturnValue({ set: () => ({ where: () => Promise.resolve(undefined) }) });
    const db = { select: selectFn, update: updateFn } as unknown as Parameters<typeof updateSubscription>[0];

    notifyChangedMock.mockClear();
    notifyRenewedMock.mockClear();
    await updateSubscription(db, 'c1', { plan_id: 'p2' });
    expect(notifyChangedMock).toHaveBeenCalledTimes(1);
    expect(notifyChangedMock).toHaveBeenCalledWith(expect.anything(), 'c1', expect.objectContaining({
      tenantName: 'Acme', oldPlanName: 'Free', newPlanName: 'Pro',
    }));
    expect(notifyRenewedMock).not.toHaveBeenCalled();
  });

  it('fires subscription.renewed when expires_at advances', async () => {
    const tenant = { id: 'c1', name: 'Acme', planId: 'p1', status: 'active', subscriptionExpiresAt: new Date('2026-06-01T00:00:00Z'), createdAt: new Date('2026-01-01') };
    const plan = { id: 'p1', name: 'Free' };
    let i = 0;
    const results: unknown[] = [tenant, tenant, plan];
    const whereFn = vi.fn().mockImplementation(() => Promise.resolve([results[i++]]));
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const updateFn = vi.fn().mockReturnValue({ set: () => ({ where: () => Promise.resolve(undefined) }) });
    const db = { select: selectFn, update: updateFn } as unknown as Parameters<typeof updateSubscription>[0];

    notifyChangedMock.mockClear();
    notifyRenewedMock.mockClear();
    await updateSubscription(db, 'c1', { subscription_expires_at: '2026-12-01T00:00:00Z' });
    expect(notifyRenewedMock).toHaveBeenCalledTimes(1);
    expect(notifyRenewedMock).toHaveBeenCalledWith(expect.anything(), 'c1', expect.objectContaining({
      tenantName: 'Acme', newExpiresAt: '2026-12-01T00:00:00.000Z',
    }));
    expect(notifyChangedMock).not.toHaveBeenCalled();
  });

  it('does NOT fire renewed when expires_at moves BACKWARDS', async () => {
    const tenant = { id: 'c1', name: 'Acme', planId: 'p1', status: 'active', subscriptionExpiresAt: new Date('2026-12-01T00:00:00Z'), createdAt: new Date('2026-01-01') };
    const plan = { id: 'p1', name: 'Free' };
    let i = 0;
    const results: unknown[] = [tenant, tenant, plan];
    const whereFn = vi.fn().mockImplementation(() => Promise.resolve([results[i++]]));
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const updateFn = vi.fn().mockReturnValue({ set: () => ({ where: () => Promise.resolve(undefined) }) });
    const db = { select: selectFn, update: updateFn } as unknown as Parameters<typeof updateSubscription>[0];

    notifyRenewedMock.mockClear();
    await updateSubscription(db, 'c1', { subscription_expires_at: '2026-06-01T00:00:00Z' });
    expect(notifyRenewedMock).not.toHaveBeenCalled();
  });

  it('should skip update when no fields provided', async () => {
    const tenant = {
      id: 'c1',
      planId: 'p1',
      status: 'active',
      subscriptionExpiresAt: null,
      createdAt: new Date('2026-01-01'),
    };
    const plan = { id: 'p1', name: 'Basic' };

    const db = createMockDb([tenant], [plan]);
    // Access the inner _updateFn for verification
    const updateFn = (db as unknown as { _updateFn: ReturnType<typeof vi.fn> })._updateFn;

    await updateSubscription(db, 'c1', {});
    expect(updateFn).not.toHaveBeenCalled();
  });
});

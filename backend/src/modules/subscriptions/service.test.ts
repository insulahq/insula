import { describe, it, expect, vi } from 'vitest';
import { getSubscription, updateSubscription } from './service.js';
import { ApiError } from '../../shared/errors.js';

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
      planId: 'p1',
      status: 'active',
      subscriptionExpiresAt: null,
      createdAt: new Date('2026-01-01'),
    };
    const plan = { id: 'p2', name: 'Pro' };

    // updateSubscription does: select(tenant), update, then getSubscription which does select(tenant), select(plan)
    // So we need 3 selects: tenant, tenant, plan
    let selectCallCount = 0;
    const results = [tenant, tenant, plan];

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

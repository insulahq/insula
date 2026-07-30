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

// getSettings hits the DB on a cold cache, which would consume the carefully
// sequenced select() fakes below. Mock it so it returns a fixed system flag
// (custom deployments enabled) without touching the mock db.
const getSettingsMock = vi.fn().mockResolvedValue({ customDeploymentsEnabled: true });
vi.mock('../system-settings/service.js', () => ({
  getSettings: (...args: unknown[]) => getSettingsMock(...args),
}));

const { getSubscription, updateSubscription, isCustomContainersAllowedByPlan } = await import('./service.js');
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

  it('effective allowCustomContainers = system AND (override ?? plan)', async () => {
    getSettingsMock.mockResolvedValue({ customDeploymentsEnabled: true });
    const base = { id: 'c1', planId: 'p1', status: 'active', subscriptionExpiresAt: null, createdAt: new Date('2026-01-01') };

    // plan allows, no override → true
    let r = await getSubscription(createMockDb([{ ...base, allowCustomContainersOverride: null }], [{ id: 'p1', allowCustomContainers: true }]), 'c1');
    expect(r.allowCustomContainers).toBe(true);

    // plan disallows, no override → false
    r = await getSubscription(createMockDb([{ ...base, allowCustomContainersOverride: null }], [{ id: 'p1', allowCustomContainers: false }]), 'c1');
    expect(r.allowCustomContainers).toBe(false);

    // plan disallows, override TRUE → true (per-tenant grant)
    r = await getSubscription(createMockDb([{ ...base, allowCustomContainersOverride: true }], [{ id: 'p1', allowCustomContainers: false }]), 'c1');
    expect(r.allowCustomContainers).toBe(true);

    // plan allows, override FALSE → false (per-tenant revoke)
    r = await getSubscription(createMockDb([{ ...base, allowCustomContainersOverride: false }], [{ id: 'p1', allowCustomContainers: true }]), 'c1');
    expect(r.allowCustomContainers).toBe(false);
  });

  it('system-wide kill-switch OFF forces allowCustomContainers false even when plan+override allow', async () => {
    getSettingsMock.mockResolvedValueOnce({ customDeploymentsEnabled: false });
    const tenant = { id: 'c1', planId: 'p1', status: 'active', subscriptionExpiresAt: null, createdAt: new Date('2026-01-01'), allowCustomContainersOverride: true };
    const r = await getSubscription(createMockDb([tenant], [{ id: 'p1', allowCustomContainers: true }]), 'c1');
    expect(r.allowCustomContainers).toBe(false);
  });
});

describe('isCustomContainersAllowedByPlan', () => {
  // NOTE: this function SELECTs projected aliases — tenant `{ planId, override }`
  // and plan `{ allow }` — so the mock rows use those alias keys, not the
  // full-column names (the mock db returns rows verbatim, no projection).
  it('resolves override ?? plan (NOT including the system kill-switch)', async () => {
    // override null → inherit plan (true)
    let ok = await isCustomContainersAllowedByPlan(createMockDb([{ planId: 'p1', override: null }], [{ allow: true }]), 'c1');
    expect(ok).toBe(true);

    // override null → inherit plan (false)
    ok = await isCustomContainersAllowedByPlan(createMockDb([{ planId: 'p1', override: null }], [{ allow: false }]), 'c1');
    expect(ok).toBe(false);

    // override FALSE beats plan true
    ok = await isCustomContainersAllowedByPlan(createMockDb([{ planId: 'p1', override: false }], [{ allow: true }]), 'c1');
    expect(ok).toBe(false);

    // override TRUE beats plan false
    ok = await isCustomContainersAllowedByPlan(createMockDb([{ planId: 'p1', override: true }], [{ allow: false }]), 'c1');
    expect(ok).toBe(true);
  });

  it('missing plan row → treated as not allowed', async () => {
    const ok = await isCustomContainersAllowedByPlan(createMockDb([{ planId: 'p1', override: null }], []), 'c1');
    expect(ok).toBe(false);
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

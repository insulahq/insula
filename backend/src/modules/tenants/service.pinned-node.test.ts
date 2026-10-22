import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '../../shared/errors.js';

// Where createTenant and updateTenant ask whether a node takes the tenant's
// tier (nodes/tenant-hosting.ts, tested on its own): the call sites, with the
// pair they pass — the node and tier the tenant WILL have.

const assertNodeTakesTier = vi.hoisted(() => vi.fn());
vi.mock('../nodes/tenant-hosting.js', () => ({ assertNodeTakesTier }));
vi.mock('./capacity-preflight.js', () => ({ assertHaTierFeasible: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../system-settings/service.js', () => ({
  getSettings: vi.fn().mockResolvedValue({ id: 'system', timezone: 'UTC', platformName: 'X', apiRateLimit: 100 }),
}));
vi.mock('bcrypt', () => ({ default: { hash: vi.fn().mockResolvedValue('h'), compare: vi.fn().mockResolvedValue(true) } }));
vi.mock('../k8s-provisioner/k8s-client.js', () => ({ createK8sClients: vi.fn(() => ({})) }));
vi.mock('../k8s-provisioner/service.js', () => ({
  applyResourceQuota: vi.fn().mockResolvedValue(undefined),
  runProvisionNamespace: vi.fn().mockResolvedValue(undefined),
  PROVISION_STEPS: [],
  buildStepsLog: vi.fn(() => []),
  mirrorProvisioningToTaskTracker: vi.fn().mockResolvedValue(undefined),
}));

import { createTenant, updateTenant } from './service.js';

const REFUSED = new ApiError('NODE_PINNED_TENANTS_ONLY', 'refused', 409);

/** Every read returns one row that is both the tenant and the node it names. */
function dbWith(row: Record<string, unknown>) {
  const where = () => {
    const p = Promise.resolve([row]);
    return Object.assign(p, { limit: () => Promise.resolve([row]) });
  };
  return {
    select: () => ({ from: () => ({ where }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    insert: () => ({ values: () => Promise.resolve(undefined) }),
    execute: vi.fn().mockResolvedValue({ rows: [{ setting_key: 'lease' }] }),
  } as unknown as Parameters<typeof updateTenant>[0];
}
const tenantRow = (over: Record<string, unknown> = {}) => ({
  id: 'c1', name: 'Acme', status: 'active', nodeName: 'za-1', storageTier: 'local', canHostTenantWorkloads: true,
  createdAt: new Date(), ...over,
});

beforeEach(() => assertNodeTakesTier.mockReset().mockResolvedValue(undefined));

describe('createTenant', () => {
  it('asks about the chosen node with the tenant\'s tier, before anything is written', async () => {
    assertNodeTakesTier.mockRejectedValueOnce(REFUSED);
    const db = dbWith(tenantRow());
    await expect(createTenant(db, {
      name: 'NC', primary_email: 'admin@nc.example.test', plan_id: 'p', node_name: 'za-1', storage_tier: 'ha',
    } as never, 'creator')).rejects.toBe(REFUSED);
    expect(assertNodeTakesTier).toHaveBeenCalledWith(db, 'za-1', 'ha', 'NC');
  });

  it('takes Local when no tier is given', async () => {
    assertNodeTakesTier.mockRejectedValueOnce(REFUSED);
    const db = dbWith(tenantRow());
    await expect(createTenant(db, { name: 'NC', primary_email: 'admin@nc.example.test', plan_id: 'p', node_name: 'za-1' } as never, 'creator'))
      .rejects.toBe(REFUSED);
    expect(assertNodeTakesTier).toHaveBeenCalledWith(db, 'za-1', 'local', 'NC');
  });
});

describe('updateTenant', () => {
  it('a flip to HA asks about the node the tenant is already on', async () => {
    assertNodeTakesTier.mockRejectedValueOnce(REFUSED);
    const db = dbWith(tenantRow({ nodeName: 'za-1', storageTier: 'local' }));
    await expect(updateTenant(db, 'c1', { storage_tier: 'ha' })).rejects.toBe(REFUSED);
    expect(assertNodeTakesTier).toHaveBeenCalledWith(db, 'za-1', 'ha', 'Acme');
  });

  it('a move asks about the new node with the tier the tenant keeps', async () => {
    assertNodeTakesTier.mockRejectedValueOnce(REFUSED);
    const db = dbWith(tenantRow({ nodeName: 'de-1', storageTier: 'ha' }));
    await expect(updateTenant(db, 'c1', { node_name: 'za-1' })).rejects.toBe(REFUSED);
    expect(assertNodeTakesTier).toHaveBeenCalledWith(db, 'za-1', 'ha', 'Acme');
  });

  it('an edit that touches neither does not ask', async () => {
    const db = dbWith(tenantRow());
    await updateTenant(db, 'c1', { name: 'Acme 2' });
    expect(assertNodeTakesTier).not.toHaveBeenCalled();
  });
});

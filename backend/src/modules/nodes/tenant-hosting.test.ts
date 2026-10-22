import { describe, it, expect, vi } from 'vitest';
import type { Database } from '../../db/index.js';
import { assertNodeTakesTier, takesAutoPlacedTenants, tenantHostingOf } from './tenant-hosting.js';

const PINNED = { 'insula.host/tenant-placement': 'pinned' };

describe('tenantHostingOf', () => {
  it('reads the mode from the host label and the placement label', () => {
    expect(tenantHostingOf({ canHostTenantWorkloads: true, labels: {} })).toBe('all');
    expect(tenantHostingOf({ canHostTenantWorkloads: true, labels: PINNED })).toBe('pinned');
    expect(tenantHostingOf({ canHostTenantWorkloads: false, labels: {} })).toBe('none');
  });

  it('hosting off wins over a placement label left from before', () => {
    expect(tenantHostingOf({ canHostTenantWorkloads: false, labels: PINNED })).toBe('none');
  });

  it('treats missing or odd labels as all', () => {
    expect(tenantHostingOf({ canHostTenantWorkloads: true })).toBe('all');
    expect(tenantHostingOf({ canHostTenantWorkloads: true, labels: null })).toBe('all');
    expect(tenantHostingOf({ canHostTenantWorkloads: true, labels: { 'insula.host/tenant-placement': 'Pinned' } })).toBe('all');
  });

  it('only an all node takes auto-placed tenants', () => {
    expect(takesAutoPlacedTenants({ canHostTenantWorkloads: true, labels: {} })).toBe(true);
    expect(takesAutoPlacedTenants({ canHostTenantWorkloads: true, labels: PINNED })).toBe(false);
    expect(takesAutoPlacedTenants({ canHostTenantWorkloads: false, labels: {} })).toBe(false);
  });
});

describe('assertNodeTakesTier', () => {
  const dbWith = (rows: Array<{ canHostTenantWorkloads: boolean; labels: unknown }>) => {
    const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }));
    return { db: { select } as unknown as Database, select };
  };

  it('refuses an HA-tier tenant on a pinned-only node, naming it', async () => {
    const { db } = dbWith([{ canHostTenantWorkloads: true, labels: PINNED }]);
    await expect(assertNodeTakesTier(db, 'za-1', 'ha', 'Acme'))
      .rejects.toMatchObject({
        code: 'NODE_PINNED_TENANTS_ONLY',
        status: 409,
        message: expect.stringContaining('Acme is on the HA storage tier'),
        details: { operatorError: { code: 'NODE_PINNED_TENANTS_ONLY' } },
      });
  });

  it('lets a Local-tier tenant onto a pinned-only node', async () => {
    const { db, select } = dbWith([{ canHostTenantWorkloads: true, labels: PINNED }]);
    await expect(assertNodeTakesTier(db, 'za-1', 'local', 'Acme')).resolves.toBeUndefined();
    // Nothing to look up for a tier the rule does not touch.
    expect(select).not.toHaveBeenCalled();
  });

  it('lets an HA-tier tenant onto an all node, and passes an unset or unknown node', async () => {
    await expect(assertNodeTakesTier(dbWith([{ canHostTenantWorkloads: true, labels: {} }]).db, 'de-1', 'ha'))
      .resolves.toBeUndefined();
    await expect(assertNodeTakesTier(dbWith([]).db, 'gone', 'ha')).resolves.toBeUndefined();
    const { db, select } = dbWith([]);
    await expect(assertNodeTakesTier(db, null, 'ha')).resolves.toBeUndefined();
    await expect(assertNodeTakesTier(db, '', 'ha')).resolves.toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });
});

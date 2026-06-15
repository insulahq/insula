/**
 * Regression for 2026-06-15: `loadTenantsOverview` cast its `db.execute()`
 * result `as unknown as Array<…>` and then called `.map` on it. But
 * drizzle-orm/node-postgres `db.execute()` returns a pg QueryResult whose
 * rows live under `.rows` — the result is NOT a bare array. `rows.map` threw
 * "rows.map is not a function" (HTTP 500), which blanked the admin Tenant
 * Backups page and blocked the restore-cart flow. (The sibling
 * loadSystemOverview / loadTenantDetail used `result[0]`, which silently
 * returned undefined → defaults instead of crashing — same root cause.)
 *
 * This drives loadTenantsOverview with a faithful `{ rows: [...] }` mock —
 * the shape real pg returns — so the bad cast can't come back. It fails on
 * the pre-fix code (rows.map is not a function) and passes on the fix.
 */
import { describe, it, expect, vi } from 'vitest';
import { loadTenantsOverview } from './service.js';
import type { Database } from '../../db/index.js';

describe('backups-overview: db.execute returns a QueryResult, not an array', () => {
  it('loadTenantsOverview maps QueryResult.rows (not the result object)', async () => {
    const db = {
      execute: vi.fn(async () => ({
        rowCount: 1,
        rows: [{
          tenant_id: 't1', tenant_name: 'Acme', is_system: false, plan_name: 'Starter',
          include_override: null, plan_include: true, resolved_include: true,
          snapshot_count: 2, snapshot_bytes: '1024', last_snapshot_at: new Date('2026-06-01T00:00:00Z'),
          bundle_count: 1, bundle_bytes: '2048', last_bundle_at: null,
          quota_max_bytes: '4096', open_cart_id: 'rstr-1',
        }],
      })),
    } as unknown as Database;

    const res = await loadTenantsOverview(db, {});
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].tenantName).toBe('Acme');
    expect(res.rows[0].snapshotBytes).toBe(1024);
    expect(res.rows[0].openCartId).toBe('rstr-1');
    expect(res.kpi.totalTenants).toBe(1);
    expect(res.kpi.openCarts).toBe(1);
  });

  it('loadTenantsOverview returns an empty rollup for an empty result set', async () => {
    const db = { execute: vi.fn(async () => ({ rowCount: 0, rows: [] })) } as unknown as Database;
    const res = await loadTenantsOverview(db, {});
    expect(res.rows).toEqual([]);
    expect(res.kpi.totalTenants).toBe(0);
  });
});

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb, runMigrations, isDbAvailable } from '../../test-helpers/db.js';
import { evaluateTenantSaturation } from './tenant-saturation.js';

/**
 * The half a fake database cannot prove.
 *
 * The unit tests script `db.execute` and so agree with whatever I believe my
 * SQL does. These run the real statements against a real Postgres, because
 * the three things that actually matter here are server semantics:
 *
 *   - ON CONFLICT ... DO UPDATE ... WHERE cleared_at IS NOT NULL re-arms a
 *     closed episode and is a NO-OP against an open one (the HA interlock).
 *   - the `last_notified_at <= NOW() - make_interval(...)` guard is a real
 *     time comparison, not a JS one, and admits exactly one winner.
 *   - `make_interval(secs => $1)` binds at all — `$1 || ' milliseconds'`
 *     does not, and would have failed only at runtime, on production.
 */

const db = getTestDb();
const dbAvailable = await isDbAvailable();
const d = dbAvailable ? describe : describe.skip;

const TENANT = 'tsat-1111-2222-3333-444444444444';

async function seedTenant(): Promise<void> {
  await db.execute(sql`
    INSERT INTO regions (id, code, name, provider, status, created_at)
    VALUES ('region-sat', 'sat', 'Sat', 'hetzner', 'active', NOW())
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO hosting_plans (id, code, name, cpu_limit, memory_limit, storage_limit, monthly_price_usd, max_sub_users, status, created_at)
    VALUES ('plan-sat', 'sat', 'Sat', 1, 1, 1, 0, 1, 'active', NOW())
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO tenants (id, region_id, name, primary_email, status, kubernetes_namespace, plan_id, created_at, updated_at)
    VALUES (${TENANT}, 'region-sat', 'Sat Tenant', 'sat@example.test', 'active', 'ns-sat', 'plan-sat', NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `);
}

async function openEpisodes(): Promise<Array<Record<string, unknown>>> {
  const r = await db.execute<Record<string, unknown>>(sql`
    SELECT resource, level, used_pct, notify_count, cleared_at
      FROM tenant_saturation_events
     WHERE tenant_id = ${TENANT}
     ORDER BY resource
  `);
  return r.rows ?? [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const M = (storageInUse: number, storageLimit: number): any => ({
  cpu: { inUse: 0, reserved: 0, available: 4 },
  memory: { inUse: 0, reserved: 0, available: 8 },
  storage: { inUse: storageInUse, reserved: storageInUse, available: storageLimit },
  lastUpdatedAt: '2026-09-21T00:00:00.000Z',
});

d('tenant saturation episodes against a real Postgres', () => {
  beforeAll(async () => {
    await runMigrations();
    await seedTenant();
  });
  beforeEach(async () => {
    await db.execute(sql`DELETE FROM tenant_saturation_events WHERE tenant_id = ${TENANT}`);
  });

  it('opens exactly one episode and then stays quiet on the next tick', async () => {
    const t0 = new Date('2026-09-21T12:00:00Z');
    const first = await evaluateTenantSaturation(db, TENANT, 'Sat Tenant', M(94, 100), undefined, t0);
    expect(first).toBe(1);

    const rows = await openEpisodes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resource: 'storage', level: 'warning', used_pct: 94, notify_count: 1 });

    // One hour later — the exact cadence that used to re-announce.
    const second = await evaluateTenantSaturation(db, TENANT, 'Sat Tenant', M(94, 100), undefined, new Date('2026-09-21T13:00:00Z'));
    expect(second).toBe(0);
    expect((await openEpisodes())[0]).toMatchObject({ notify_count: 1 });
  });

  it('two concurrent replicas produce ONE notification, not two', async () => {
    // Both evaluate the same tenant in the same instant, as the two api
    // replicas in HA mode do. The guarded INSERT is the only interlock.
    const t0 = new Date('2026-09-21T12:00:00Z');
    const [a, b] = await Promise.all([
      evaluateTenantSaturation(db, TENANT, 'Sat Tenant', M(94, 100), undefined, t0),
      evaluateTenantSaturation(db, TENANT, 'Sat Tenant', M(94, 100), undefined, t0),
    ]);
    expect(a + b).toBe(1);
    expect(await openEpisodes()).toHaveLength(1);
  });

  it('escalates to critical, then resolves, then can open a NEW episode', async () => {
    await evaluateTenantSaturation(db, TENANT, 'Sat Tenant', M(94, 100), undefined, new Date('2026-09-21T12:00:00Z'));

    // 96% crosses the storage critical threshold — immediate, ladder ignored.
    const esc = await evaluateTenantSaturation(db, TENANT, 'Sat Tenant', M(96, 100), undefined, new Date('2026-09-21T12:05:00Z'));
    expect(esc).toBe(1);
    expect((await openEpisodes())[0]).toMatchObject({ level: 'critical', notify_count: 1 });

    // 84% is below warn - hysteresis, so the episode closes.
    const res = await evaluateTenantSaturation(db, TENANT, 'Sat Tenant', M(84, 100), undefined, new Date('2026-09-21T14:00:00Z'));
    expect(res).toBe(1);
    const cleared = await openEpisodes();
    expect(cleared[0].cleared_at).not.toBeNull();

    // A later re-occurrence must re-arm the SAME row, not be swallowed by it.
    const again = await evaluateTenantSaturation(db, TENANT, 'Sat Tenant', M(97, 100), undefined, new Date('2026-09-22T09:00:00Z'));
    expect(again).toBe(1);
    const reopened = await openEpisodes();
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).toMatchObject({ level: 'critical', notify_count: 1 });
    expect(reopened[0].cleared_at).toBeNull();
  });

  it('holds the episode open across the hysteresis band without speaking', async () => {
    await evaluateTenantSaturation(db, TENANT, 'Sat Tenant', M(94, 100), undefined, new Date('2026-09-21T12:00:00Z'));
    // 87% is under the 90% threshold but inside the band: still one open
    // warning episode, and nothing said.
    const held = await evaluateTenantSaturation(db, TENANT, 'Sat Tenant', M(87, 100), undefined, new Date('2026-09-21T12:10:00Z'));
    expect(held).toBe(0);
    const rows = await openEpisodes();
    expect(rows[0]).toMatchObject({ level: 'warning' });
    expect(rows[0].cleared_at).toBeNull();
  });

  it('the reminder age guard is a real interval comparison', async () => {
    await evaluateTenantSaturation(db, TENANT, 'Sat Tenant', M(94, 100), undefined, new Date('2026-09-21T12:00:00Z'));
    // Backdate the stamp past the first (1h) rung.
    await db.execute(sql`
      UPDATE tenant_saturation_events
         SET last_notified_at = NOW() - INTERVAL '90 minutes'
       WHERE tenant_id = ${TENANT} AND resource = 'storage'
    `);
    const reminded = await evaluateTenantSaturation(db, TENANT, 'Sat Tenant', M(94, 100), undefined, new Date('2026-09-21T13:30:00Z'));
    expect(reminded).toBe(1);
    expect((await openEpisodes())[0]).toMatchObject({ notify_count: 2 });

    // The second rung is 6h, so an immediate re-run says nothing.
    const quiet = await evaluateTenantSaturation(db, TENANT, 'Sat Tenant', M(94, 100), undefined, new Date('2026-09-21T13:31:00Z'));
    expect(quiet).toBe(0);
  });
});

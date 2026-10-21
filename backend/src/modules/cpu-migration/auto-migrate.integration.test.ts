/**
 * The automatic CPU migrator's database side, against real Postgres: who it
 * picks, when it waits, and what it records.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { deployments, tenants } from '../../db/schema.js';
import { createAutoMigrateDeps } from './auto-migrate.js';

const dbAvailable = await isDbAvailable();
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe.skipIf(!dbAvailable)('cpu auto-migrate deps (integration)', () => {
  const db = () => getTestDb();
  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql`DELETE FROM platform_settings WHERE setting_key LIKE 'cpu\\_auto\\_migrate\\_attempt:%'`);
  });

  it('lists only legacy tenants, oldest first; waits on a rollout; marks tiered; keeps attempts', async () => {
    const regionId = (await seedRegion(db())).id;
    const planId = (await seedPlan(db())).id;
    const older = await seedTenant(db(), regionId, planId, { cpuSchedulingMode: 'legacy', createdAt: new Date(Date.now() - 2 * 86_400_000) });
    const newer = await seedTenant(db(), regionId, planId, { cpuSchedulingMode: 'legacy' });
    await seedTenant(db(), regionId, planId, { cpuSchedulingMode: 'tiered' });

    const deps = createAutoMigrateDeps(db(), {} as never, log);
    expect((await deps.listLegacy()).map((t) => t.id)).toEqual([older.id, newer.id]);

    // A deployment mid-rollout makes the tenant wait; a running one does not.
    await db().insert(deployments).values({
      id: 'dep-1', tenantId: older.id, name: 'web', status: 'running', cpuRequest: '0.25',
    } as typeof deployments.$inferInsert);
    expect(await deps.rollingOut(older.id)).toBe(false);
    await db().execute(sql`UPDATE deployments SET status = 'deploying' WHERE id = 'dep-1'`);
    expect(await deps.rollingOut(older.id)).toBe(true);

    await deps.recordAttempt(newer.id, { at: '2026-10-20T01:00:00.000Z', outcome: 'failed', reason: 'x' });
    expect(await deps.lastAttempt(newer.id)).toEqual({ at: '2026-10-20T01:00:00.000Z', outcome: 'failed', reason: 'x' });
    expect(await deps.lastAttempt(older.id)).toBeNull();

    await deps.markTiered(newer.id);
    const [row] = await db().select({ mode: tenants.cpuSchedulingMode, at: tenants.cpuMigratedAt })
      .from(tenants).where(sql`id = ${newer.id}`);
    expect(row.mode).toBe('tiered');
    expect(row.at).not.toBeNull();
    expect((await deps.listLegacy()).map((t) => t.id)).toEqual([older.id]);
  });
});

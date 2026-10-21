/**
 * Migration 0159 writes down the burst ceiling every plan (and tenant) without
 * one used to DERIVE from its cores — `max(1, cores x 2)` — so retiring cores
 * moves no tenant's ceiling. Run against real Postgres: the rows are put back
 * into their pre-migration shape, the migration's own SQL is run, and every
 * tenant's resolved ceiling is compared before and after.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant } from '../test-helpers/fixtures.js';
import { hostingPlans, tenants } from './schema.js';
import { resolveTenantCpu } from '../modules/cpu-migration/resolve.js';
import { ceilingCores } from '../modules/cpu-migration/tiers.js';

const dbAvailable = await isDbAvailable();
const MIGRATION = readFileSync(fileURLToPath(new URL('./migrations/0159_cpu_cores_retired.sql', import.meta.url)), 'utf8');

/** What the resolver answered BEFORE 0159: the old derivation from cores. */
function oldCeiling(planCores: string, planBurst: string | null, tCores: string | null, tBurst: string | null): number {
  if (tBurst !== null) return Number(tBurst);
  if (planBurst !== null) return Number(planBurst);
  return ceilingCores(Number(tCores ?? planCores));
}

describe.skipIf(!dbAvailable)('migration 0159 — CPU cores retired (integration)', () => {
  const db = () => getTestDb();
  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => {
    await db().execute(sql.raw('ALTER TABLE hosting_plans ALTER COLUMN cpu_burst_cores SET NOT NULL'));
    await closeTestDb();
  });
  beforeEach(async () => {
    await cleanTables();
    // The pre-0159 shape: a plan may state no ceiling.
    await db().execute(sql.raw('ALTER TABLE hosting_plans ALTER COLUMN cpu_burst_cores DROP NOT NULL'));
  });

  it('every tenant resolves to the same ceiling after it as before it', async () => {
    const regionId = (await seedRegion(db())).id;
    const cases = [
      // plan cores, plan ceiling, tenant cores override, tenant ceiling override
      ['0.10', null, null, null],
      ['1.00', null, '0.50', null],
      ['1.00', null, '4.00', null],
      ['2.00', '3.00', '0.10', null],
      ['2.00', null, '1.00', '5.00'],
      ['0.25', '6.00', null, null],
    ] as const;
    const before: Record<string, number> = {};
    for (const [pc, pb, tc, tb] of cases) {
      const p = await seedPlan(db(), { cpuLimit: pc });
      await db().execute(sql`UPDATE hosting_plans SET cpu_burst_cores = ${pb} WHERE id = ${p.id}`);
      const t = await seedTenant(db(), regionId, p.id, {
        cpuSchedulingMode: 'tiered', cpuLimitOverride: tc, cpuBurstCoresOverride: tb,
      });
      before[t.id] = oldCeiling(pc, pb, tc, tb);
    }

    await db().execute(sql.raw(MIGRATION));
    // …and it is idempotent.
    await db().execute(sql.raw(MIGRATION));

    const rows = await db().select().from(tenants);
    const plans = new Map((await db().select().from(hostingPlans)).map((p) => [p.id, p]));
    for (const t of rows) {
      const p = plans.get(t.planId)!;
      expect(p.cpuBurstCores).not.toBeNull();
      const after = resolveTenantCpu(
        { cpuLimit: p.cpuLimit, cpuTier: p.cpuTier, cpuBurstCores: p.cpuBurstCores },
        { cpuSchedulingMode: 'tiered', cpuLimitOverride: t.cpuLimitOverride, cpuTierOverride: t.cpuTierOverride, cpuBurstCoresOverride: t.cpuBurstCoresOverride },
      ).burstCores;
      expect(after, `tenant on plan cores ${p.cpuLimit}, override ${t.cpuLimitOverride}`).toBe(before[t.id]);
    }
  });

  it('leaves a stated ceiling exactly as it was', async () => {
    const p = await seedPlan(db(), { cpuLimit: '2.00', cpuBurstCores: '7.50' });
    await db().execute(sql.raw(MIGRATION));
    const [row] = await db().select().from(hostingPlans).where(sql`id = ${p.id}`);
    expect(row.cpuBurstCores).toBe('7.50');
  });
});

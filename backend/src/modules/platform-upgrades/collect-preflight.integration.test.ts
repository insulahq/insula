/**
 * Which storage operations the upgrade pre-flight counts as in flight —
 * against a REAL Postgres with every migration applied.
 *
 * Needs a database — CI's integration job provides DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { storageOperations, tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { inFlightStorageOperations } from './collect-preflight.js';
import { evaluatePreflight } from './preflight.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('upgrade pre-flight: storage operations in flight (real Postgres)', () => {
  const db = () => getTestDb() as unknown as Database;
  let regionId = '';
  let planId = '';

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    regionId = (await seedRegion(db())).id;
    planId = (await seedPlan(db())).id;
  });

  type State = typeof storageOperations.$inferInsert['state'];
  type Kind = typeof storageOperations.$inferInsert['opType'];
  /** A tenant with one operation; `active` — the tenant's row points at it. */
  const tenantWithOp = async (name: string, kind: Kind, state: State, active = true, minutesAgo = 5) => {
    const t = await seedTenant(db(), regionId, planId, { name });
    const id = crypto.randomUUID();
    await db().insert(storageOperations).values({ id, tenantId: t.id, opType: kind, state, createdAt: new Date(Date.now() - minutesAgo * 60_000) });
    if (active) await db().update(tenants).set({ activeStorageOpId: id, storageLifecycleState: state }).where(eq(tenants.id, t.id));
    return t;
  };

  it('none: an install with no operation at all', async () => {
    await seedTenant(db(), regionId, planId, { name: 'Quiet' });
    expect(await inFlightStorageOperations(db())).toEqual([]);
  });

  it('lists the operation each tenant\'s row points at while it has not ended, oldest first, with the tenant\'s name', async () => {
    await tenantWithOp('Young Resize', 'resize', 'replacing', true, 2);
    await tenantWithOp('Old Restore', 'restore', 'restoring', true, 40);
    await tenantWithOp('Archive', 'archive', 'snapshotting', true, 10);
    expect(await inFlightStorageOperations(db())).toEqual([
      { tenant: 'Old Restore', kind: 'restore' },
      { tenant: 'Archive', kind: 'archive' },
      { tenant: 'Young Resize', kind: 'resize' },
    ]);
  });

  it('not an operation that has ended, well or badly', async () => {
    await tenantWithOp('Done', 'resize', 'idle');
    await tenantWithOp('Failed', 'restore', 'failed');
    expect(await inFlightStorageOperations(db())).toEqual([]);
  });

  it('not a row an earlier release left open that no tenant points at: nothing would be cut off', async () => {
    await tenantWithOp('Stale Row', 'resize', 'replacing', false, 60 * 24 * 30);
    expect(await inFlightStorageOperations(db())).toEqual([]);
  });

  it('feeds the gate: a resize in flight blocks a production upgrade and is named', async () => {
    await tenantWithOp('Acme', 'resize', 'replacing');
    const result = evaluatePreflight({
      environment: 'production', cnpgReady: true, cnpgDetail: '', longhornAtRiskVolumes: 0, inFlightTransitions: 0,
      maxDiskUsedPct: 10, nodesWithDiskPressure: 0, freshestBackupAgeHours: 1, fluxSuspended: [],
      storageOperations: await inFlightStorageOperations(db()),
    });
    const gate = result.gates.find((g) => g.id === 'no-storage-operation-running');
    expect(gate).toMatchObject({ status: 'fail' });
    expect(gate?.detail).toContain('resize of Acme');
    expect(result.ok).toBe(false);
  });

  it('says "unreadable" when the database does not answer — never "none"', async () => {
    const broken = { select: () => { throw new Error('connection terminated'); } } as unknown as Database;
    expect(await inFlightStorageOperations(broken)).toBeNull();
  });
});

/**
 * Backups pause while a tenant is suspended — against real Postgres, because
 * every rule here is SQL (suspension.ts).
 *
 * Without this, the nightly wave bundles a suspended tenant anyway; suspension
 * blocks every sign-in on its mailboxes, so the mailbox capture fails and the
 * bundle goes `partial` with an admin alert — every night. Meanwhile retention
 * keeps expiring the tenant's existing bundles until none are left.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { backupJobs, backupSchedules } from '../../db/schema.js';
import { selectWaveTenants } from './global-scheduler.js';
import { runRetentionSweep } from './retention.js';
import type { FastifyInstance } from 'fastify';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('backups pause while a tenant is suspended (integration)', () => {
  const db = () => getTestDb();
  const app = () => ({ db: db(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }) as unknown as FastifyInstance;
  let regionId = '';
  let planId = '';

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql.raw('TRUNCATE TABLE backup_jobs CASCADE'));
    await db().execute(sql.raw('TRUNCATE TABLE backup_schedules CASCADE'));
    regionId = (await seedRegion(db())).id;
    planId = (await seedPlan(db())).id;
  });

  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
  let seq = 0;
  /** A bundle with no target, so the sweep's expiry is a pure DB flip. */
  async function bundle(tenantId: string, opts: { createdDaysAgo: number; expired: boolean; status?: 'completed' | 'partial' | 'failed' }) {
    seq += 1;
    const id = `bkp-test-${String(seq).padStart(4, '0')}`;
    await db().insert(backupJobs).values({
      id,
      tenantId,
      initiator: 'system',
      status: opts.status ?? 'completed',
      targetKind: 's3',
      targetUri: 's3://example.test/bundles',
      retentionDays: 7,
      createdAt: daysAgo(opts.createdDaysAgo),
      expiresAt: opts.expired ? daysAgo(1) : new Date(Date.now() + 86_400_000),
    } as typeof backupJobs.$inferInsert);
    return id;
  }
  const statusOf = async (id: string) =>
    (await db().select({ s: backupJobs.status }).from(backupJobs).where(eq(backupJobs.id, id)))[0]?.s;

  it('the nightly wave skips suspended (and archived) tenants', async () => {
    const active = await seedTenant(db(), regionId, planId, { name: 'Active Co' });
    await seedTenant(db(), regionId, planId, { name: 'Suspended Co', status: 'suspended' });
    await seedTenant(db(), regionId, planId, { name: 'Archived Co', status: 'archived' });

    const wave = await selectWaveTenants(db());
    expect(wave.map((t) => t.id)).toEqual([active.id]);
  });

  it('retention does not expire a suspended tenant\'s bundles, however old', async () => {
    const t = await seedTenant(db(), regionId, planId, { status: 'suspended' });
    const old = await bundle(t.id, { createdDaysAgo: 40, expired: true });
    const older = await bundle(t.id, { createdDaysAgo: 41, expired: true });

    await runRetentionSweep(app());
    expect(await statusOf(old)).toBe('completed');
    expect(await statusOf(older)).toBe('completed');
  });

  it('keep-last-N does not push a suspended tenant\'s bundles out either', async () => {
    await db().insert(backupSchedules).values({ subsystem: 'tenant_bundle', retentionCount: 1 } as typeof backupSchedules.$inferInsert);
    const t = await seedTenant(db(), regionId, planId, { status: 'suspended' });
    const newest = await bundle(t.id, { createdDaysAgo: 1, expired: false });
    const second = await bundle(t.id, { createdDaysAgo: 2, expired: false });

    await runRetentionSweep(app());
    expect(await statusOf(newest)).toBe('completed');
    expect(await statusOf(second)).toBe('completed');
  });

  it('a live tenant keeps its newest restorable bundle until a newer one completes', async () => {
    const t = await seedTenant(db(), regionId, planId);
    const newest = await bundle(t.id, { createdDaysAgo: 30, expired: true });
    const older = await bundle(t.id, { createdDaysAgo: 31, expired: true });

    await runRetentionSweep(app());
    expect(await statusOf(older)).toBe('expired');
    expect(await statusOf(newest)).toBe('completed'); // the only restore point left

    await bundle(t.id, { createdDaysAgo: 0, expired: false }); // the next nightly bundle lands
    await runRetentionSweep(app());
    expect(await statusOf(newest)).toBe('expired');
  });

  it('a failed bundle is not a restore point — it still expires', async () => {
    const t = await seedTenant(db(), regionId, planId);
    const failed = await bundle(t.id, { createdDaysAgo: 30, expired: true, status: 'failed' });
    await runRetentionSweep(app());
    expect(await statusOf(failed)).toBe('expired');
  });

  it('a partial bundle counts as a restore point', async () => {
    const t = await seedTenant(db(), regionId, planId);
    const partial = await bundle(t.id, { createdDaysAgo: 30, expired: true, status: 'partial' });
    await runRetentionSweep(app());
    expect(await statusOf(partial)).toBe('partial');
  });

  it('archived and deleted tenants still age out completely', async () => {
    const archived = await seedTenant(db(), regionId, planId, { status: 'archived' });
    const a = await bundle(archived.id, { createdDaysAgo: 30, expired: true });
    const d = await bundle('00000000-0000-4000-8000-00000000dead', { createdDaysAgo: 30, expired: true }); // tenant row gone

    await runRetentionSweep(app());
    expect(await statusOf(a)).toBe('expired');
    expect(await statusOf(d)).toBe('expired');
  });

  it('reactivation resumes normal expiry', async () => {
    const t = await seedTenant(db(), regionId, planId, { status: 'suspended' });
    const newest = await bundle(t.id, { createdDaysAgo: 30, expired: true });
    const older = await bundle(t.id, { createdDaysAgo: 31, expired: true });
    await runRetentionSweep(app());
    expect(await statusOf(older)).toBe('completed');

    await db().execute(sql`UPDATE tenants SET status = 'active' WHERE id = ${t.id}`);
    await runRetentionSweep(app());
    expect(await statusOf(older)).toBe('expired');
    expect(await statusOf(newest)).toBe('completed'); // held until the next bundle completes
  });
});

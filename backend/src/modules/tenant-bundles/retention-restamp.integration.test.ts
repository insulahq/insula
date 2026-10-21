/**
 * A changed retention reaches the bundles that already exist.
 *
 * Production lowered the tenant-bundle days from 30 to 14 and every bundle
 * made before the change kept its 30-day expiry — 432 of them, on every
 * tenant — while the setting read 14. The sweep now re-applies the schedule's
 * current days to nightly bundles on every tick. Run against real Postgres:
 * the interval arithmetic and the timestamp comparisons are the point.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { backupJobs, backupSchedules, restoreItems, restoreJobs } from '../../db/schema.js';
import { runRetentionSweep } from './retention.js';
import type { FastifyInstance } from 'fastify';

const dbAvailable = await isDbAvailable();
const DAY = 86_400_000;

describe.skipIf(!dbAvailable)('retention days reach existing bundles (integration)', () => {
  const db = () => getTestDb();
  const app = () => ({ db: db(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } as unknown as FastifyInstance);
  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql.raw('TRUNCATE TABLE backup_jobs CASCADE'));
    await db().execute(sql.raw('TRUNCATE TABLE backup_schedules CASCADE'));
  });

  async function schedule(retentionDays: number | null, retentionCount: number | null = null) {
    await db().insert(backupSchedules).values({ subsystem: 'tenant_bundle', enabled: true, cronExpression: '0 2 * * *', retentionDays, retentionCount });
  }

  let seq = 0;
  /** A bundle made `ageDays` ago under a `stampedDays` retention. */
  async function bundle(tenantId: string, ageDays: number, opts: {
    stampedDays?: number | null; trigger?: 'scheduled' | 'manual' | 'pre_archive'; initiator?: 'system' | 'admin' | 'tenant';
  } = {}) {
    seq += 1;
    const id = `bkp-restamp-${String(seq).padStart(4, '0')}`;
    const createdAt = new Date(Date.now() - ageDays * DAY);
    const stamped = opts.stampedDays === undefined ? 30 : opts.stampedDays;
    await db().insert(backupJobs).values({
      id, tenantId, initiator: opts.initiator ?? 'system', systemTrigger: opts.trigger ?? 'scheduled',
      status: 'completed', targetKind: 's3', targetUri: 's3://example.test/b',
      retentionDays: stamped ?? 0, createdAt,
      expiresAt: stamped === null ? null : new Date(createdAt.getTime() + stamped * DAY),
    } as typeof backupJobs.$inferInsert);
    return id;
  }

  const rows = async () => new Map(((await db().execute(sql`
    SELECT id, status, retention_days, expires_at, created_at FROM backup_jobs`)) as unknown as {
    rows: Array<{ id: string; status: string; retention_days: number; expires_at: Date | null; created_at: Date }> }).rows
    .map((r) => [r.id, r]));
  const expiryDays = (r: { expires_at: Date | null; created_at: Date }) =>
    r.expires_at === null ? null : Math.round((new Date(r.expires_at).getTime() - new Date(r.created_at).getTime()) / DAY);

  async function tenant() {
    const regionId = (await seedRegion(db())).id;
    const planId = (await seedPlan(db())).id;
    return seedTenant(db(), regionId, planId);
  }

  it('lowering the days expires the nightly bundles that no longer fit — this tick', async () => {
    const t = await tenant();
    await schedule(14);
    const fresh = await bundle(t.id, 0);
    const young = await bundle(t.id, 5);
    const old = await bundle(t.id, 20);
    const older = await bundle(t.id, 25);

    const res = await runRetentionSweep(app());
    const after = await rows();
    expect(after.get(old)!.status).toBe('expired');
    expect(after.get(older)!.status).toBe('expired');
    expect(after.get(young)!.status).toBe('completed');
    expect(expiryDays(after.get(young)!)).toBe(14);
    expect(after.get(young)!.retention_days).toBe(14);
    expect(after.get(fresh)!.status).toBe('completed');
    expect(res.restampedByDays).toBe(4);
    expect(res.expiredDeleted).toBe(2);
  });

  it('raising the days lets the bundles that have not expired yet live longer', async () => {
    const t = await tenant();
    await schedule(60);
    await bundle(t.id, 0);
    const twentyDays = await bundle(t.id, 20); // 30-day stamp: 10 days left
    await runRetentionSweep(app());
    const after = await rows();
    expect(after.get(twentyDays)!.status).toBe('completed');
    expect(expiryDays(after.get(twentyDays)!)).toBe(60);
  });

  it('leaves manual and pre-archive bundles on the retention they were given', async () => {
    const t = await tenant();
    await schedule(7);
    await bundle(t.id, 0);
    const manual = await bundle(t.id, 10, { trigger: 'manual', initiator: 'admin' });
    const archive = await bundle(t.id, 10, { trigger: 'pre_archive', stampedDays: 90 });
    await runRetentionSweep(app());
    const after = await rows();
    expect(after.get(manual)!.status).toBe('completed');
    expect(expiryDays(after.get(manual)!)).toBe(30);
    expect(after.get(archive)!.status).toBe('completed');
    expect(expiryDays(after.get(archive)!)).toBe(90);
  });

  it('never ages out a tenant\'s only restore point', async () => {
    // Nightlies stopped: the one bundle left is older than the new window.
    const t = await tenant();
    await schedule(14);
    const only = await bundle(t.id, 20);
    await runRetentionSweep(app());
    expect((await rows()).get(only)!.status).toBe('completed');
  });

  it('does not pull a bundle out from under an open restore', async () => {
    const t = await tenant();
    await schedule(14);
    await bundle(t.id, 0);
    const inRestore = await bundle(t.id, 20);
    const other = await bundle(t.id, 21);
    await db().insert(restoreJobs).values({ id: 'rj-1', tenantId: t.id, status: 'executing' } as typeof restoreJobs.$inferInsert);
    await db().insert(restoreItems).values({
      id: 'ri-1', restoreJobId: 'rj-1', bundleId: inRestore, type: 'files-paths', selector: {}, seq: 1,
    } as typeof restoreItems.$inferInsert);
    await runRetentionSweep(app());
    const after = await rows();
    expect(after.get(inRestore)!.status).toBe('completed');
    expect(expiryDays(after.get(inRestore)!)).toBe(30);
    expect(after.get(other)!.status).toBe('expired');
  });

  it('a count-only schedule lifts the age limit from nightly bundles', async () => {
    const t = await tenant();
    await schedule(null, 14);
    const b = await bundle(t.id, 3);
    await runRetentionSweep(app());
    const after = (await rows()).get(b)!;
    expect(after.expires_at).toBeNull();
    expect(after.status).toBe('completed');
  });

  it('a row set to 0 days and no count still means "never expire"', async () => {
    const t = await tenant();
    await schedule(0, null);
    const b = await bundle(t.id, 40, { stampedDays: null });
    await bundle(t.id, 0, { stampedDays: null });
    await runRetentionSweep(app());
    const after = (await rows()).get(b)!;
    expect(after.expires_at).toBeNull();
    expect(after.status).toBe('completed');
  });

  it('leaves a suspended tenant\'s bundles alone until it is resumed, as keep-last does', async () => {
    const regionId = (await seedRegion(db())).id;
    const planId = (await seedPlan(db())).id;
    const held = await seedTenant(db(), regionId, planId, { status: 'suspended' });
    await schedule(14);
    await bundle(held.id, 0);
    const old = await bundle(held.id, 20);
    await runRetentionSweep(app());
    const before = (await rows()).get(old)!;
    expect(before.status).toBe('completed');
    expect(expiryDays(before)).toBe(30);
    // Resumed: the next tick applies the days.
    await db().execute(sql`UPDATE tenants SET status = 'active' WHERE id = ${held.id}`);
    await runRetentionSweep(app());
    expect((await rows()).get(old)!.status).toBe('expired');
  });

  it('a second tick changes nothing', async () => {
    const t = await tenant();
    await schedule(14);
    await bundle(t.id, 0);
    await bundle(t.id, 5);
    await runRetentionSweep(app());
    const again = await runRetentionSweep(app());
    expect(again.restampedByDays).toBe(0);
  });
});

/**
 * The expiry sweep and every "is this a restore point?" query must agree,
 * bundle for bundle. If the sweep keeps a bundle the restic reconciler does
 * not count as live, the reconciler forgets its snapshots — the data is
 * destroyed while the row still reads `completed`. Real Postgres: the rules
 * are SQL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { backupComponents, backupJobs } from '../../db/schema.js';
import { bundleIsLive } from './bundle-hold.js';
import { runRetentionSweep } from './retention.js';
import { newestRecoverableBundleId } from './recoverable.js';
import type { FastifyInstance } from 'fastify';

const dbAvailable = await isDbAvailable();
const DELETED_TENANT = '00000000-0000-4000-8000-00000000dead';

describe.skipIf(!dbAvailable)('bundle liveness is one rule (integration)', () => {
  const db = () => getTestDb();
  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql.raw('TRUNCATE TABLE backup_jobs CASCADE'));
    await db().execute(sql.raw('TRUNCATE TABLE backup_schedules CASCADE'));
  });

  let seq = 0;
  async function bundle(tenantId: string, createdDaysAgo: number, expired: boolean, status: 'completed' | 'partial' | 'failed' = 'completed') {
    seq += 1;
    const id = `bkp-hold-${String(seq).padStart(4, '0')}`;
    await db().insert(backupJobs).values({
      id, tenantId, initiator: 'system', status, targetKind: 's3', targetUri: 's3://example.test/b', retentionDays: 7,
      createdAt: new Date(Date.now() - createdDaysAgo * 86_400_000),
      expiresAt: expired ? new Date(Date.now() - 86_400_000) : new Date(Date.now() + 86_400_000),
    } as typeof backupJobs.$inferInsert);
    return id;
  }

  async function seedEveryCase() {
    const regionId = (await seedRegion(db())).id;
    const planId = (await seedPlan(db())).id;
    for (const status of ['active', 'suspended', 'archived', 'pending'] as const) {
      const t = await seedTenant(db(), regionId, planId, { status });
      await bundle(t.id, 1, false);
      await bundle(t.id, 30, true);
      await bundle(t.id, 31, true, 'partial');
      await bundle(t.id, 32, true, 'failed');
    }
    const onlyOld = await seedTenant(db(), regionId, planId); // nightlies stopped long ago
    await bundle(onlyOld.id, 40, true);
    await bundle(onlyOld.id, 41, true);
    await bundle(DELETED_TENANT, 30, true);
    await bundle(DELETED_TENANT, 31, true);
  }

  const liveIds = async () => new Set(((await db().execute(sql`
    SELECT id FROM backup_jobs bj WHERE ${bundleIsLive('bj')}`)) as unknown as { rows: Array<{ id: string }> }).rows.map((r) => r.id));
  const statuses = async () => new Map(((await db().execute(sql`SELECT id, status FROM backup_jobs`)) as unknown as {
    rows: Array<{ id: string; status: string }> }).rows.map((r) => [r.id, r.status]));

  it('after a sweep, every restorable row is either expired or live — never kept-but-not-live', async () => {
    await seedEveryCase();
    const live = await liveIds();
    await runRetentionSweep({ db: db(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } as unknown as FastifyInstance);
    const after = await statuses();

    const disagreements: string[] = [];
    for (const [id, status] of after) {
      if (status === 'failed' || status === 'expired') continue;
      // Kept by the sweep (still completed/partial) ⇒ the reconciler must keep its snapshots.
      if (!live.has(id)) disagreements.push(`${id} kept by the sweep (${status}) but NOT live — its snapshots would be forgotten`);
    }
    for (const id of live) {
      if (after.get(id) === 'expired') disagreements.push(`${id} live but expired by the sweep`);
    }
    expect(disagreements).toEqual([]);
  });

  it('the cases come out as designed', async () => {
    await seedEveryCase();
    const live = await liveIds();
    const rows = ((await db().execute(sql`
      SELECT bj.id, coalesce(t.status::text, 'deleted') AS tenant, bj.status, bj.expires_at < now() AS past,
             row_number() OVER (PARTITION BY bj.tenant_id ORDER BY bj.created_at DESC) AS rn
        FROM backup_jobs bj LEFT JOIN tenants t ON t.id = bj.tenant_id`)) as unknown as {
      rows: Array<{ id: string; tenant: string; status: string; past: boolean; rn: number }> }).rows;
    const liveOf = (tenant: string) => rows.filter((r) => r.tenant === tenant && live.has(r.id)).length;
    expect(liveOf('suspended')).toBe(3); // every restorable bundle, however old
    expect(liveOf('archived')).toBe(1);  // only the unexpired one
    expect(liveOf('deleted')).toBe(0);   // ages out completely
    // The tenant whose nightlies stopped keeps exactly its newest bundle.
    const stale = rows.filter((r) => r.tenant === 'active' && r.past && Number(r.rn) === 1);
    expect(stale.every((r) => live.has(r.id))).toBe(true);
  });

  async function component(bundleId: string, name: 'files' | 'mailboxes', status: 'completed' | 'failed' | 'skipped') {
    seq += 1;
    await db().insert(backupComponents).values({
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      backupJobId: bundleId, component: name, artifactName: `${name}.restic`, status,
    } as typeof backupComponents.$inferInsert);
  }

  it('keeps the newest completed copy of each component — a newer partial bundle is not enough', async () => {
    const regionId = (await seedRegion(db())).id;
    const planId = (await seedPlan(db())).id;
    const t = await seedTenant(db(), regionId, planId);
    const old = await bundle(t.id, 30, true);                  // files + mail, expired
    await component(old, 'files', 'completed');
    await component(old, 'mailboxes', 'completed');
    const newer = await bundle(t.id, 2, false, 'partial');      // mail capture failed
    await component(newer, 'files', 'completed');
    await component(newer, 'mailboxes', 'failed');
    const skippedOnly = await bundle(t.id, 1, false);           // nothing to capture for mail
    await component(skippedOnly, 'files', 'completed');
    await component(skippedOnly, 'mailboxes', 'skipped');

    expect((await liveIds()).has(old)).toBe(true);
    await runRetentionSweep({ db: db(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } as unknown as FastifyInstance);
    expect((await statuses()).get(old)).toBe('completed');      // the last mail copy survives the sweep

    // A newer bundle that completes mail releases it.
    const full = await bundle(t.id, 0.5, false);
    await component(full, 'files', 'completed');
    await component(full, 'mailboxes', 'completed');
    expect((await liveIds()).has(old)).toBe(false);
    await runRetentionSweep({ db: db(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } as unknown as FastifyInstance);
    expect((await statuses()).get(old)).toBe('expired');
  });

  it('a recover picks a held bundle when it is the only one left', async () => {
    const regionId = (await seedRegion(db())).id;
    const planId = (await seedPlan(db())).id;
    const t = await seedTenant(db(), regionId, planId, { status: 'suspended' });
    const only = await bundle(t.id, 60, true);
    expect(await newestRecoverableBundleId(db(), t.id)).toBe(only);
  });
});

describe('no query decides bundle liveness on its own', () => {
  // Every "still a restore point?" check must go through bundle-hold.ts. A raw
  // `expires_at > now()` beside a `completed`/`partial` filter is exactly the
  // shape that let the restic keep-set disagree with the expiry sweep.
  const ROOTS = ['tenant-bundles', 'dr-recover', 'backup-restore', 'backups-overview'].map((m) => join(import.meta.dirname, '..', m));
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : (p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : []);
  });
  it('raw expires_at liveness appears only where it is deliberate', () => {
    const allowed = new Set(['bundle-hold.ts', 'retention.ts', 'database-predump-orchestration.ts']);
    const offenders = ROOTS.flatMap(files)
      .filter((p) => !allowed.has(p.split('/').pop() ?? ''))
      .filter((p) => /expires_at\s*>\s*(now\(\)|\$\{)/i.test(readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

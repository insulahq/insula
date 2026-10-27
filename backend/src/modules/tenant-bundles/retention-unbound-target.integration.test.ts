/**
 * Expiry leaves a bundle on a target tenant backups are no longer bound to.
 *
 * The expiry sweep deletes through the shim, which serves only the bound
 * target. For a bundle on another target it found nothing there, took that
 * for "already gone" and marked the bundle expired — and the reclaimer then
 * purged the row, with the data still on the old target. Insula does not write
 * to a target it is not bound to (unbound-target.ts), so such a bundle is not
 * touched at all. Against real Postgres: the filter is SQL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { backupConfigurations, backupJobs } from '../../db/schema.js';
import type { FastifyInstance } from 'fastify';

const BOUND = '00000000-0000-4000-8000-0000000000b1';
const OLD = '00000000-0000-4000-8000-0000000000a1';
const opened: string[] = [];
const shim = { served: true };

vi.mock('../backup-source-shim/service.js', async (orig) => ({
  ...(await orig<typeof import('../backup-source-shim/service.js')>()),
  boundTenantTargetId: vi.fn(async () => BOUND),
}));
vi.mock('../backup-rclone-shim/served.js', () => ({ shimServesCurrentBindings: vi.fn(async () => shim.served) }));
vi.mock('../k8s-provisioner/k8s-client.js', async (orig) => ({
  ...(await orig<typeof import('../k8s-provisioner/k8s-client.js')>()),
  createK8sClients: vi.fn(() => ({})),
}));
// The shim's store: it finds none of these bundles (the store is not what is
// under test — which bundles are handed to it is).
vi.mock('./shim-backup-store.js', () => ({
  resolveShimFirstBackupStore: vi.fn(async () => ({
    kind: 's3',
    open: vi.fn(async (id: string) => { opened.push(id); return null; }),
    delete: vi.fn(),
  })),
}));

const { runRetentionSweep } = await import('./retention.js');
const dbAvailable = await isDbAvailable();
const DAY = 86_400_000;

describe.skipIf(!dbAvailable)('expiry and bundles on a target tenant backups are no longer bound to (integration)', () => {
  const db = () => getTestDb();
  const app = () => ({ db: db(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } as unknown as FastifyInstance);
  const savedKey = process.env.PLATFORM_ENCRYPTION_KEY;
  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql.raw('TRUNCATE TABLE backup_jobs CASCADE'));
    await db().execute(sql.raw('TRUNCATE TABLE backup_configurations CASCADE'));
    await db().insert(backupConfigurations).values([
      { id: BOUND, name: 'bound-target', storageType: 's3' },
      { id: OLD, name: 'old-target', storageType: 's3' },
    ] as Array<typeof backupConfigurations.$inferInsert>);
    process.env.PLATFORM_ENCRYPTION_KEY = 'a'.repeat(64);
    opened.length = 0;
    shim.served = true;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.PLATFORM_ENCRYPTION_KEY;
    else process.env.PLATFORM_ENCRYPTION_KEY = savedKey;
  });

  let seq = 0;
  async function expiredBundle(tenantId: string, targetConfigId: string | null): Promise<string> {
    seq += 1;
    const id = `bkp-unbound-${String(seq).padStart(4, '0')}`;
    await db().insert(backupJobs).values({
      id, tenantId, initiator: 'admin', status: 'completed', targetKind: 's3', targetUri: 's3://example.test/b',
      targetConfigId, retentionDays: 1, createdAt: new Date(Date.now() - 3 * DAY), expiresAt: new Date(Date.now() - DAY),
    } as typeof backupJobs.$inferInsert);
    return id;
  }
  const status = async (id: string): Promise<string> => ((await db().execute(sql`
    SELECT status FROM backup_jobs WHERE id = ${id}`)) as unknown as { rows: Array<{ status: string }> }).rows[0]!.status;
  /** A live tenant with a fresh bundle: its newest restore point is held past expiry (bundle-hold.ts), and must not be one of these. */
  async function tenant() {
    const t = await seedTenant(db(), (await seedRegion(db())).id, (await seedPlan(db())).id);
    await db().insert(backupJobs).values({
      id: `bkp-unbound-fresh-${t.id.slice(0, 8)}`, tenantId: t.id, initiator: 'system', status: 'completed', targetKind: 's3',
      targetUri: 's3://example.test/b', targetConfigId: BOUND, retentionDays: 7, expiresAt: new Date(Date.now() + 7 * DAY),
    } as typeof backupJobs.$inferInsert);
    return t;
  }

  it('a bundle on the old target is left as it is; bound and target-less ones expire', async () => {
    const t = await tenant();
    const old = await expiredBundle(t.id, OLD);
    const onBound = await expiredBundle(t.id, BOUND);
    const legacy = await expiredBundle(t.id, null);

    await runRetentionSweep(app());

    expect(await status(old)).toBe('completed');
    expect(opened).not.toContain(old);
    expect(await status(onBound)).toBe('expired');
    expect(opened).toContain(onBound);
    expect(await status(legacy)).toBe('expired');
  });

  // Rebinding a target to delete its kept bundles writes the binding first;
  // until the shim has rolled onto it, it still serves the previous target,
  // where none of them is — they would all read as "already gone".
  it('while the shim has not rolled onto the binding, bundles on the bound target wait too', async () => {
    shim.served = false;
    const t = await tenant();
    const onBound = await expiredBundle(t.id, BOUND);
    const legacy = await expiredBundle(t.id, null);

    await runRetentionSweep(app());

    expect(await status(onBound)).toBe('completed');
    expect(opened).not.toContain(onBound);
    expect(await status(legacy)).toBe('expired');
  });

  it('the bound target cannot be told: only target-less bundles expire', async () => {
    delete process.env.PLATFORM_ENCRYPTION_KEY;
    const t = await tenant();
    const old = await expiredBundle(t.id, OLD);
    const onBound = await expiredBundle(t.id, BOUND);
    const legacy = await expiredBundle(t.id, null);

    await runRetentionSweep(app());

    expect(await status(old)).toBe('completed');
    expect(await status(onBound)).toBe('completed');
    expect(opened).toEqual([]);
    expect(await status(legacy)).toBe('expired');
  });
});

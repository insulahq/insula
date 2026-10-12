/**
 * Starting an archive — against a REAL Postgres with every migration applied.
 *
 * An archive runs under a lock of its own (`archiveLockJob`), and that lock is
 * what the watchdog reads "interrupted" from. So an archive whose lock could
 * not be taken must not be left claimed: nothing would be running it, and
 * nothing would ever pick it up.
 *
 * Needs a database — CI's integration job provides DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { storageOperations, storageSnapshots, tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const did: string[] = [];
/** What asking for an archive's lock comes to: taken, held by another process, or the database not answering. */
let claim: 'taken' | 'held elsewhere' | 'database down' = 'taken';

vi.mock('../../shared/exclusive-run.js', async (orig) => {
  const actual = await orig<typeof import('../../shared/exclusive-run.js')>();
  return {
    ...actual,
    runExclusive: (db: never, job: string, fn: () => Promise<unknown>, opts: never) => {
      if (job.startsWith('storage-op:')) {
        if (claim === 'database down') return Promise.reject(new Error('connection terminated unexpectedly'));
        if (claim === 'held elsewhere') return Promise.resolve({ ran: false });
      }
      return actual.runExclusive(db, job, fn, opts);
    },
  };
});
vi.mock('./quiesce.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  quiesce: async (_k8s: unknown, _ns: string, persist?: (snap: unknown) => Promise<void>) => {
    did.push('quiesce');
    const snap = { deployments: [], cronJobs: [] };
    await persist?.(snap);
    return snap;
  },
  waitForQuiesced: async () => undefined,
  unquiesce: async () => { did.push('unquiesce'); },
}));
vi.mock('./prebundle.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  captureFilesOnlyBundle: async () => { did.push('capture'); return { bundleId: 'bkp-1', status: 'completed', sizeBytes: 10 }; },
}));
vi.mock('../tenant-lifecycle/cascades.js', () => ({
  applyArchived: async (ctx: { db: Database }, tenantId: string) => {
    did.push('cascade');
    await ctx.db.update(tenants).set({ status: 'archived', archivedAt: new Date() }).where(eq(tenants.id, tenantId));
    return 't-1';
  },
}));

const { archiveTenant } = await import('./service.js');
const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('starting an archive (real Postgres)', () => {
  const db = () => getTestDb() as unknown as Database;
  let tenantId = '';
  const k8s = {
    apps: { listNamespacedDeployment: async () => ({ items: [] }) },
    batch: { listNamespacedCronJob: async () => ({ items: [] }), deleteNamespacedJob: async () => undefined },
    core: { listNamespacedService: async () => ({ items: [] }), deleteNamespacedPersistentVolumeClaim: async () => { did.push('delete claim'); } },
    custom: {},
  } as unknown as K8sClients;
  const ctx = () => ({ db: db(), k8s, store: {}, platformNamespace: 'platform' }) as never;

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql.raw(`DELETE FROM platform_settings WHERE setting_key LIKE 'scheduler-lease:%'`));
    const region = await seedRegion(db());
    const plan = await seedPlan(db());
    tenantId = (await seedTenant(db(), region.id, plan.id, { status: 'suspended', suspendedAt: new Date(Date.now() - 40 * 86_400_000) })).id;
    did.length = 0; claim = 'taken';
  });

  const tenantRow = async () => (await db().select().from(tenants).where(eq(tenants.id, tenantId)))[0];
  const ops = () => db().select().from(storageOperations).where(eq(storageOperations.tenantId, tenantId));
  const snaps = () => db().select().from(storageSnapshots).where(eq(storageSnapshots.tenantId, tenantId));
  const leases = async (): Promise<number> => ((await db().execute(sql`SELECT 1 FROM platform_settings WHERE setting_key LIKE 'scheduler-lease:%'`)) as unknown as { rows: unknown[] }).rows.length;

  it('answers once the archive is running under its lock, and the archive then runs to its end', async () => {
    const { operationId } = await archiveTenant(ctx(), tenantId);
    for (let i = 0; i < 100; i += 1) {
      const [row] = await ops();
      if (row?.completedAt) break;
      await new Promise((resolve) => { setTimeout(resolve, 30); });
    }
    expect(await ops()).toMatchObject([{ id: operationId, state: 'idle', progressPct: 100 }]);
    expect(await tenantRow()).toMatchObject({ status: 'archived', storageLifecycleState: 'idle', activeStorageOpId: null });
    expect(did).toEqual(['quiesce', 'capture', 'delete claim', 'cascade']);
    expect(await leases()).toBe(0);                    // the tenant's lock and the archive's, both given back
  });

  it.each(['database down', 'held elsewhere'] as const)('with the lock %s, the request fails and the tenant is left as it was — not claimed by an archive nobody runs', async (state) => {
    claim = state;
    const outcome = await archiveTenant(ctx(), tenantId).then(() => null, (err: unknown) => err);
    expect(outcome).toMatchObject({ code: 'ARCHIVE_NOT_STARTED', status: 503 });
    expect(did).toEqual([]);
    expect(await tenantRow()).toMatchObject({ status: 'suspended', storageLifecycleState: 'idle', activeStorageOpId: null });
    const [op] = await ops();
    expect(op).toMatchObject({ state: 'failed' });
    expect(op.completedAt).not.toBeNull();
    expect(op.lastError).toContain('its lock could not be taken');
    expect(await snaps()).toMatchObject([{ status: 'failed' }]);
    // …so the next attempt is not refused as "an operation is in progress".
    claim = 'taken';
    await expect(archiveTenant(ctx(), tenantId)).resolves.toMatchObject({ operationId: expect.any(String) });
  });
});

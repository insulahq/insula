/**
 * Per-database snapshots against real Postgres: the `databases` component
 * value (migration 0192), the rows a bundle records and what the restore
 * cart's picker and the restore read back from them, and the retention gate
 * that keeps a bundle until its database snapshots are reclaimed.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { cleanTables, closeTestDb, getTestDb, isDbAvailable, runMigrations } from '../../test-helpers/db.js';
import { seedPlan, seedRegion, seedTenant } from '../../test-helpers/fixtures.js';
import { backupComponents, backupJobs, catalogEntries, deployments } from '../../db/schema.js';
import { browseBundleDatabases } from './browse-databases.js';
import { loadDatabaseSnapshotRows } from './executors/databases-from-snapshots.js';
import { purgeFullyReclaimedBundles } from '../tenant-bundles/restic-retention.js';
import { databaseArtifactName } from '../tenant-bundles/components/database-snapshots.js';

const dbAvailable = await isDbAvailable();
const db = () => getTestDb();
const app = () => ({ db: db() }) as unknown as FastifyInstance;

describe.skipIf(!dbAvailable)('per-database snapshots (integration)', () => {
  let tenantId = '';
  let dbEntry = '';

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    for (const t of ['backup_components', 'backup_jobs', 'deployments', 'catalog_entries']) await db().execute(sql.raw(`TRUNCATE TABLE ${t} CASCADE`));
    const tenant = await seedTenant(db(), (await seedRegion(db())).id, (await seedPlan(db())).id);
    tenantId = tenant.id;
    dbEntry = randomUUID();
    await db().insert(catalogEntries).values({ id: dbEntry, code: 'mariadb', name: 'MariaDB', type: 'database' } as typeof catalogEntries.$inferInsert);
  });

  async function seedInstance(name: string, extra: Partial<typeof deployments.$inferInsert> = {}): Promise<string> {
    const id = randomUUID();
    await db().insert(deployments).values({ id, tenantId, name, catalogEntryId: dbEntry, cpuRequest: '0.25', status: 'running', ...extra } as typeof deployments.$inferInsert);
    return id;
  }

  async function seedBundle(status: 'completed' | 'expired', snaps: Array<{ deploymentId: string; database: string; snapshotId: string; reclaimed?: boolean }>, summary: unknown = null): Promise<string> {
    const id = `bkp-${randomUUID()}`;
    await db().insert(backupJobs).values({
      id, tenantId, initiator: 'admin', status, targetKind: 's3', targetUri: 's3://x', sizeBytes: 0, retentionDays: 30, databaseDumps: summary,
    } as typeof backupJobs.$inferInsert);
    for (const s of snaps) {
      await db().insert(backupComponents).values({
        id: randomUUID(), backupJobId: id, component: 'databases', artifactName: databaseArtifactName(s.deploymentId, s.database),
        status: 'completed', sizeBytes: 10, sha256: s.snapshotId, snapshotReclaimedAt: s.reclaimed ? new Date() : null,
      } as typeof backupComponents.$inferInsert);
    }
    return id;
  }

  it('records a row per database under the new component value, and reads it back', async () => {
    const maria = await seedInstance('maria');
    const bundle = await seedBundle('completed', [
      { deploymentId: maria, database: 'shop', snapshotId: 'aaaaaaaa' },
      { deploymentId: maria, database: 'odd:name', snapshotId: 'bbbbbbbb' },
    ]);
    const rows = await loadDatabaseSnapshotRows(app(), bundle);
    expect(rows.sort((a, b) => a.database.localeCompare(b.database))).toEqual([
      { deploymentId: maria, database: 'odd:name', snapshotId: 'bbbbbbbb' },
      { deploymentId: maria, database: 'shop', snapshotId: 'aaaaaaaa' },
    ]);
  });

  it('the picker lists each instance\'s databases, sizes and versions, and which can be restored into', async () => {
    const maria = await seedInstance('maria');
    const gone = await seedInstance('old-pg', { deletedAt: new Date(), status: 'deleted' });
    const detached = await seedInstance('parked', { dataDetachedPath: 'kept-databases/parked' });
    const summary = {
      status: 'ok',
      deployments: [{ deploymentId: maria, deploymentName: 'maria', engine: 'mariadb', databases: [{ name: 'shop', status: 'dumped', sizeBytes: 42, snapshotId: 'aaaaaaaa', serverVersion: '10.11.9' }] }],
    };
    const bundle = await seedBundle('completed', [
      { deploymentId: maria, database: 'shop', snapshotId: 'aaaaaaaa' },
      { deploymentId: gone, database: 'x', snapshotId: 'cccccccc' },
      { deploymentId: detached, database: 'y', snapshotId: 'dddddddd' },
    ], summary);
    const view = await browseBundleDatabases(app(), bundle, tenantId);
    expect(view.perDatabase).toBe(true);
    const byName = Object.fromEntries(view.instances.map((i) => [i.deploymentName, i]));
    expect(byName.maria).toMatchObject({ available: true, engine: 'mariadb', databases: [{ name: 'shop', sizeBytes: 42, serverVersion: '10.11.9' }] });
    expect(byName[gone]?.available ?? view.instances.find((i) => i.deploymentId === gone)!.available).toBe(false);
    expect(byName.parked).toMatchObject({ available: false, unavailableReason: 'its data is detached: attach it first' });
  });

  it('another tenant\'s instance is never offered as a target', async () => {
    const other = await seedTenant(db(), (await seedRegion(db())).id, (await seedPlan(db())).id);
    const foreign = randomUUID();
    await db().insert(deployments).values({ id: foreign, tenantId: other.id, name: 'theirs', catalogEntryId: dbEntry, cpuRequest: '0.25', status: 'running' } as typeof deployments.$inferInsert);
    const bundle = await seedBundle('completed', [{ deploymentId: foreign, database: 'x', snapshotId: 'aaaaaaaa' }]);
    const view = await browseBundleDatabases(app(), bundle, tenantId);
    expect(view.instances[0]!.available).toBe(false);
  });

  it('an older bundle offers whole instances from its summary', async () => {
    const maria = await seedInstance('maria');
    const bundle = await seedBundle('completed', [], {
      status: 'ok',
      deployments: [
        { deploymentId: maria, deploymentName: 'maria', engine: 'mariadb', databases: [{ name: 'shop', status: 'dumped', sizeBytes: 5 }, { name: '(deployment)', status: 'failed', sizeBytes: 0 }] },
        { deploymentId: '', deploymentName: '(sqlite files)', engine: 'sqlite', databases: [{ name: 'a.db', status: 'dumped', sizeBytes: 1 }] },
      ],
    });
    const view = await browseBundleDatabases(app(), bundle, tenantId);
    expect(view.perDatabase).toBe(false);
    expect(view.instances).toHaveLength(1);
    expect(view.instances[0]!.databases.map((d) => d.name)).toEqual(['shop']);
  });

  it('retention keeps an expired bundle until its database snapshots are reclaimed', async () => {
    const maria = await seedInstance('maria');
    const bundle = await seedBundle('expired', [
      { deploymentId: maria, database: 'shop', snapshotId: 'aaaaaaaa', reclaimed: true },
      { deploymentId: maria, database: 'blog', snapshotId: 'bbbbbbbb' },
    ]);
    expect(await purgeFullyReclaimedBundles(db(), tenantId)).toEqual([]);
    await db().update(backupComponents).set({ snapshotReclaimedAt: new Date() }).where(eq(backupComponents.backupJobId, bundle));
    expect(await purgeFullyReclaimedBundles(db(), tenantId)).toEqual([bundle]);
  });
});

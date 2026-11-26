/**
 * The SQL half of the database backup status, against real Postgres: the
 * recorder's out-of-order-safe upsert, keyset paging with the instance state,
 * the scheduled run the sweep judges against, and the two queries the review
 * found unbounded or unordered (the pre-dump's deployment list, the wave).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { cleanTables, closeTestDb, getTestDb, isDbAvailable, runMigrations } from '../../test-helpers/db.js';
import { seedPlan, seedRegion, seedTenant } from '../../test-helpers/fixtures.js';
import { backupJobs, backupSchedules, catalogEntries, databaseBackupStatus, deployments } from '../../db/schema.js';
import { recordDatabaseBackupResults } from './recorder.js';
import { loadRowPage, pageKey, resolveJudgedRun } from './sweep.js';
import { runPreCaptureDatabaseDumps } from '../tenant-bundles/components/database-predump-orchestration.js';
import { selectWaveTenants } from '../tenant-bundles/global-scheduler.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('database backup status (integration)', () => {
  const db = () => getTestDb();
  let regionId = '';
  let planId = '';
  let tenantId = '';

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    for (const t of ['database_backup_status', 'backup_jobs', 'backup_schedules', 'deployments', 'catalog_entries']) {
      await db().execute(sql.raw(`TRUNCATE TABLE ${t} CASCADE`));
    }
    regionId = (await seedRegion(db())).id;
    planId = (await seedPlan(db())).id;
    tenantId = (await seedTenant(db(), regionId, planId)).id;
  });

  const summary = (dbs: Array<{ name: string; status: 'dumped' | 'failed'; error?: string }>) => ({
    status: 'ok' as const,
    deployments: [{ deploymentId: 'dep-1', deploymentName: 'my-mariadb', engine: 'mariadb', databases: dbs.map((d) => ({ sizeBytes: 5, ...d })) }],
  });
  async function seedDeployment(id: string, status: string, deletedAt: Date | null = null) {
    const cat = randomUUID();
    await db().insert(catalogEntries).values({ id: cat, code: `mariadb-${id}`, name: 'MariaDB', type: 'database' } as typeof catalogEntries.$inferInsert);
    await db().insert(deployments).values({
      id, tenantId, name: id, status, deletedAt, catalogEntryId: cat, cpuRequest: '0.25',
    } as typeof deployments.$inferInsert);
  }

  it('a bundle that finishes late never moves a newer attempt or success backwards', async () => {
    await seedDeployment('dep-1', 'running');
    const newer = new Date('2026-11-26T03:00:00Z');
    const older = new Date('2026-11-26T02:00:00Z');
    await recordDatabaseBackupResults(db(), { tenantId, bundleId: 'bkp-new', at: newer, summary: summary([{ name: 'shop', status: 'dumped' }]), snapshotKept: true, sqliteCaptureComplete: true });
    await recordDatabaseBackupResults(db(), { tenantId, bundleId: 'bkp-old', at: older, summary: summary([{ name: 'shop', status: 'failed', error: 'boom' }]), snapshotKept: true, sqliteCaptureComplete: true });
    const [r] = await db().select().from(databaseBackupStatus);
    expect(r).toMatchObject({ lastAttemptBundleId: 'bkp-new', lastStatus: 'dumped', lastError: null, lastSuccessBundleId: 'bkp-new' });
    expect(r!.lastSuccessAt!.toISOString()).toBe(newer.toISOString());
  });

  it('pages a tenant\'s rows once each, overdue first, with each instance\'s state', async () => {
    await seedDeployment('dep-1', 'running');
    await seedDeployment('dep-2', 'stopped');
    await seedDeployment('dep-3', 'deleted', new Date());
    const at = new Date('2026-11-26T02:00:00Z');
    const base = { tenantId, deploymentName: 'x', engine: 'mariadb', lastAttemptAt: at, lastAttemptBundleId: 'b', lastStatus: 'dumped' as const };
    await db().insert(databaseBackupStatus).values([
      { ...base, subjectKey: 'dep-1', deploymentId: 'dep-1', databaseName: 'a' },
      { ...base, subjectKey: 'dep-1', deploymentId: 'dep-1', databaseName: 'b', staleSince: at },
      { ...base, subjectKey: 'dep-2', deploymentId: 'dep-2', databaseName: 'c' },
      { ...base, subjectKey: 'dep-3', deploymentId: 'dep-3', databaseName: 'd' },
      { ...base, subjectKey: 'dep-9', deploymentId: 'dep-9', databaseName: 'e' },
      { ...base, subjectKey: 'sqlite', deploymentId: null, databaseName: '/data/x.db' },
    ]);
    const seen: Array<[string, string]> = [];
    let after: string[] | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await loadRowPage(db(), { tenantId }, { limit: 2, after });
      seen.push(...page.rows.map((r) => [r.databaseName, r.instanceState] as [string, string]));
      if (!page.hasMore) break;
      after = pageKey(page.rows[page.rows.length - 1]!, 'tenant');
    }
    expect(seen).toEqual([
      ['b', 'active'], ['a', 'active'], ['c', 'stopped'], ['d', 'removed'], ['e', 'removed'], ['/data/x.db', 'active'],
    ]);
  });

  it('judges the run whose wave has had its measured length plus an hour, never one still running', async () => {
    await db().insert(backupSchedules).values({ subsystem: 'tenant_bundle', enabled: true, cronExpression: '0 2 * * *', lastFiredAt: new Date('2026-11-26T02:00:00Z') } as typeof backupSchedules.$inferInsert);
    const job = (id: string, started: string, finished: string | null, status = 'completed') => ({
      id, tenantId, initiator: 'system', systemTrigger: 'scheduled', status, targetKind: 's3', targetUri: 's3://example.test/b', retentionDays: 7,
      startedAt: new Date(started), finishedAt: finished ? new Date(finished) : null, createdAt: new Date(started),
    } as typeof backupJobs.$inferInsert);
    // Last night's wave ran three hours: allowance four.
    await db().insert(backupJobs).values([job('w1', '2026-11-25T02:00:00Z', '2026-11-25T02:30:00Z'), job('w2', '2026-11-25T04:00:00Z', '2026-11-25T05:00:00Z')]);
    expect((await resolveJudgedRun(db(), new Date('2026-11-26T05:30:00Z')))!.toISOString()).toBe('2026-11-25T02:00:00.000Z');
    expect((await resolveJudgedRun(db(), new Date('2026-11-26T06:00:00Z')))!.toISOString()).toBe('2026-11-26T02:00:00.000Z');
    // Tonight's wave still running: tonight's run is not judged, however late.
    await db().insert(backupJobs).values(job('w3', '2026-11-26T02:00:00Z', null, 'running'));
    expect((await resolveJudgedRun(db(), new Date('2026-11-26T09:00:00Z')))!.toISOString()).toBe('2026-11-25T02:00:00.000Z');
    // Enabled after tonight's run time: tonight's run never fired, so last night's is judged.
    await db().execute(sql`DELETE FROM backup_jobs WHERE id = 'w3'`);
    await db().execute(sql`UPDATE backup_schedules SET last_fired_at = ${new Date('2026-11-25T02:00:00Z')}`);
    expect((await resolveJudgedRun(db(), new Date('2026-11-26T09:00:00Z')))!.toISOString()).toBe('2026-11-25T02:00:00.000Z');
    // Schedule off: nothing is judged.
    await db().execute(sql`UPDATE backup_schedules SET enabled = false`);
    expect(await resolveJudgedRun(db(), new Date('2026-11-26T09:00:00Z'))).toBeNull();
  });

  it('the pre-dump leaves deleted and stopped database deployments alone', async () => {
    await seedDeployment('dep-deleted', 'deleted', new Date());
    await seedDeployment('dep-soft', 'running', new Date());
    await seedDeployment('dep-stopped', 'stopped');
    // No Kubernetes client: the call may only succeed because nothing is listed.
    const results = await runPreCaptureDatabaseDumps({ db: db(), k8s: undefined as never, tenantId, namespace: 'tenant-x', backupId: 'bkp-1' });
    expect(results).toEqual([]);
  });

  it('the wave bundles tenants in a stable order', async () => {
    const later = (await seedTenant(db(), regionId, planId, { createdAt: new Date('2026-06-01T00:00:00Z') } as never)).id;
    const earlier = (await seedTenant(db(), regionId, planId, { createdAt: new Date('2026-01-01T00:00:00Z') } as never)).id;
    const ids = (await selectWaveTenants(db() as never)).map((t) => t.id).filter((id) => id === later || id === earlier);
    expect(ids).toEqual([earlier, later]);
  });
});

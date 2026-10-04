/**
 * The Backups & DR card reads each class from ITS OWN source — real Postgres,
 * because the sources are tables and settings rows written by other parts of
 * the platform.
 *
 * The bug this pins: SYSTEM showed a months-old manual secrets export as "the
 * last system backup" (and its 246 KB as the size), MAIL showed the tenant
 * bundles' mailbox component with no size, and TENANT's size was the bytes the
 * last snapshot PROCESSED rather than what the repositories hold.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { buildBackupClasses } from './backup-classes.js';
import { recordSystemLastSuccess, storeSystemFootprint } from '../system-backup/footprint-store.js';
import type { ClusterBackupHealth } from '../cnpg-backup-health/service.js';

const dbAvailable = await isDbAvailable();
const NOW = new Date('2026-10-04T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe.skipIf(!dbAvailable)('dashboard backup classes (integration)', () => {
  const db = () => getTestDb();
  let targetId = '';
  let tenantId = '';

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    for (const t of ['backup_jobs', 'backup_schedules', 'tenant_restic_repo_state', 'backup_target_assignments', 'platform_settings', 'system_wal_archive_state', 'system_backup_runs']) {
      await db().execute(sql.raw(`TRUNCATE TABLE ${t} CASCADE`));
    }
    targetId = randomUUID();
    await db().execute(sql`INSERT INTO backup_configurations (id, name, "storageType") VALUES (${targetId}, 'StorageBox', 'cifs')`);
    for (const cls of ['system', 'tenant', 'mail']) {
      await db().execute(sql`INSERT INTO backup_target_assignments (backup_class, target_id) VALUES (${cls}, ${targetId})`);
    }
    const regionId = (await seedRegion(db())).id;
    const planId = (await seedPlan(db())).id;
    tenantId = (await seedTenant(db(), regionId, planId)).id;
  });

  const health = (finishedHoursAgo: number, name = 'system-db-backup-1'): ClusterBackupHealth[] => [{
    clusterName: 'system-db', namespace: 'platform', state: 'healthy',
    lastSuccessfulBackup: {
      name, namespace: 'platform', clusterName: 'system-db', method: 'plugin', phase: 'completed',
      startedAt: hoursAgo(finishedHoursAgo + 0.1).toISOString(), stoppedAt: hoursAgo(finishedHoursAgo).toISOString(), error: null,
    },
    mostRecentFailure: null, lastSuccessSecondsAgo: 0, scheduledBackups: [], clusterHasBackupSpec: true,
  } as unknown as ClusterBackupHealth];

  it('SYSTEM: the newest CNPG base backup and the measured target footprint — not a manual export', async () => {
    // The trap: an old manual secrets export, tiny.
    await db().execute(sql`INSERT INTO system_backup_runs (id, kind, status, finished_at, size_bytes) VALUES (${randomUUID()}, 'secrets', 'succeeded', ${new Date('2026-08-24T19:47:02Z')}, 246008)`);
    await db().execute(sql`INSERT INTO system_wal_archive_state (cluster_namespace, cluster_name, target_config_id, destination_path, base_backup_schedule) VALUES ('platform', 'system-db', ${targetId}, 's3://system/c1/postgres', '0 0 */6 * * *')`);
    await recordSystemLastSuccess(db(), health(2));
    await storeSystemFootprint(db(), {
      measuredAt: hoursAgo(0.5).toISOString(), totalBytes: 12_500_000_000, objectCount: 4200, truncated: false, error: null,
      parts: [{ name: 'postgres', prefix: 'system/c/postgres/', bytes: 12_000_000_000, objects: 4000, truncated: false, error: null }],
    });

    const sys = (await buildBackupClasses(db(), NOW)).classes.find((c) => c.backupClass === 'system')!;
    expect(sys.lastSuccessAt).toBe(hoursAgo(2).toISOString());
    expect(sys.repoBytes).toBe(12_500_000_000);
    expect(sys.repoMeasuredAt).toBe(hoursAgo(0.5).toISOString());
    expect(sys.healthy).toBe(true);
  });

  it('SYSTEM: overdue against its 6-hourly schedule → not healthy, and says why', async () => {
    await db().execute(sql`INSERT INTO system_wal_archive_state (cluster_namespace, cluster_name, target_config_id, destination_path, base_backup_schedule) VALUES ('platform', 'system-db', ${targetId}, 's3://system/c1/postgres', '0 0 */6 * * *')`);
    await recordSystemLastSuccess(db(), health(20));
    const sys = (await buildBackupClasses(db(), NOW)).classes.find((c) => c.backupClass === 'system')!;
    expect(sys.healthy).toBe(false);
    expect(sys.healthDetail).toMatch(/scheduled run\(s\) missed/);
  });

  it('SYSTEM: an unreadable target leaves the size unmeasured, never 0', async () => {
    await storeSystemFootprint(db(), {
      measuredAt: NOW.toISOString(), totalBytes: 0, objectCount: 0, truncated: false,
      error: 'the system target could not be listed: postgres: NoSuchBucket', parts: [],
    });
    const sys = (await buildBackupClasses(db(), NOW)).classes.find((c) => c.backupClass === 'system')!;
    expect(sys.repoBytes).toBeNull();
  });

  it('the recorded last system backup never moves backwards', async () => {
    await recordSystemLastSuccess(db(), health(1, 'newer'));
    await recordSystemLastSuccess(db(), health(7, 'older'));
    const sys = (await buildBackupClasses(db(), NOW)).classes.find((c) => c.backupClass === 'system')!;
    expect(sys.lastSuccessAt).toBe(hoursAgo(1).toISOString());
  });

  it('MAIL: the mail store snapshot — its run time and repository size', async () => {
    await db().execute(sql`
      INSERT INTO system_settings (id, mail_snapshot_last_run_stats)
      VALUES ('system', ${JSON.stringify({ runAt: hoursAgo(0.2).toISOString(), snapshotCount: 53, totalSnapshotSizeBytes: 38_833_929_049 })}::jsonb)
      ON CONFLICT (id) DO UPDATE SET mail_snapshot_last_run_stats = EXCLUDED.mail_snapshot_last_run_stats`);
    await db().execute(sql`INSERT INTO backup_schedules (subsystem, enabled, cron_expression) VALUES ('mail', true, '37 * * * *')`);
    // A tenant bundle's mailbox component is NOT the mail class.
    await db().execute(sql`INSERT INTO backup_jobs (id, tenant_id, initiator, status, target_kind, target_uri, retention_days, created_at, finished_at)
      VALUES ('bkp-old', ${tenantId}, 'system', 'completed', 's3', 's3://example.test/b', 7, ${hoursAgo(50)}, ${hoursAgo(49)})`);

    const mail = (await buildBackupClasses(db(), NOW)).classes.find((c) => c.backupClass === 'mail')!;
    expect(mail.lastSuccessAt).toBe(hoursAgo(0.2).toISOString());
    expect(mail.repoBytes).toBe(38_833_929_049);
    expect(mail.healthy).toBe(true);
  });

  it('a switched-off schedule is NOT healthy, however recent the last success', async () => {
    await db().execute(sql`
      INSERT INTO system_settings (id, mail_snapshot_last_run_stats)
      VALUES ('system', ${JSON.stringify({ runAt: hoursAgo(0.2).toISOString(), snapshotCount: 5, totalSnapshotSizeBytes: 1_000_000 })}::jsonb)
      ON CONFLICT (id) DO UPDATE SET mail_snapshot_last_run_stats = EXCLUDED.mail_snapshot_last_run_stats`);
    await db().execute(sql`INSERT INTO backup_schedules (subsystem, enabled, cron_expression) VALUES ('mail', false, '37 * * * *')`);
    // System: a recent base backup, but periodic base backups switched off (no schedule).
    await recordSystemLastSuccess(db(), health(1));

    const out = await buildBackupClasses(db(), NOW);
    for (const cls of ['mail', 'system'] as const) {
      expect(out.classes.find((c) => c.backupClass === cls)).toMatchObject({
        healthy: false, healthDetail: expect.stringMatching(/switched off/),
      });
    }
  });

  it('MAIL: a 0 posted by a failed `restic stats` is "not measured", not an empty repository', async () => {
    await db().execute(sql`
      INSERT INTO system_settings (id, mail_snapshot_last_run_stats)
      VALUES ('system', ${JSON.stringify({ runAt: hoursAgo(0.2).toISOString(), snapshotCount: 0, totalSnapshotSizeBytes: 0 })}::jsonb)
      ON CONFLICT (id) DO UPDATE SET mail_snapshot_last_run_stats = EXCLUDED.mail_snapshot_last_run_stats`);
    const mail = (await buildBackupClasses(db(), NOW)).classes.find((c) => c.backupClass === 'mail')!;
    expect(mail.repoBytes).toBeNull();
  });

  it('TENANT: stored bytes are the repositories\' totals, and the time is when the newest bundle FINISHED', async () => {
    await db().execute(sql`INSERT INTO backup_jobs (id, tenant_id, initiator, status, target_kind, target_uri, retention_days, created_at, finished_at)
      VALUES ('bkp-1', ${tenantId}, 'system', 'completed', 's3', 's3://example.test/b', 7, ${hoursAgo(9)}, ${hoursAgo(8)})`);
    for (const [component, processed, total] of [['files', 10_000, 70_000_000_000], ['mailboxes', 90_000, 0]] as const) {
      await db().execute(sql`INSERT INTO tenant_restic_repo_state (tenant_id, component, repo_uri, target_config_id, last_repo_size_bytes, repo_total_bytes)
        VALUES (${tenantId}, ${component}, 's3:http://shim/tenant/t1', ${targetId}, ${processed}, ${total})`);
    }
    const out = await buildBackupClasses(db(), NOW);
    const tenant = out.classes.find((c) => c.backupClass === 'tenant')!;
    expect(tenant.lastSuccessAt).toBe(hoursAgo(8).toISOString());
    expect(tenant.repoBytes).toBe(70_000_000_000);
    expect(tenant.repoBytesPartial).toBe(false);
    expect(out.repoBytes).toBe(70_000_000_000);
  });

  it('TENANT: a repository not measured yet makes the total a floor', async () => {
    await db().execute(sql`INSERT INTO tenant_restic_repo_state (tenant_id, component, repo_uri, target_config_id, last_repo_size_bytes, repo_total_bytes)
      VALUES (${tenantId}, 'files', 's3:http://shim/tenant/t1', ${targetId}, 5, NULL)`);
    const tenant = (await buildBackupClasses(db(), NOW)).classes.find((c) => c.backupClass === 'tenant')!;
    expect(tenant.repoBytesPartial).toBe(true);
  });

  it('no target, no success: not healthy, with the reason', async () => {
    await db().execute(sql`DELETE FROM backup_target_assignments WHERE backup_class = 'mail'`);
    await db().execute(sql`INSERT INTO system_wal_archive_state (cluster_namespace, cluster_name, target_config_id, destination_path, base_backup_schedule) VALUES ('platform', 'system-db', ${targetId}, 's3://system/c1/postgres', '0 0 */6 * * *')`);
    const out = await buildBackupClasses(db(), NOW);
    expect(out.classes.find((c) => c.backupClass === 'mail')).toMatchObject({ healthy: false, healthDetail: 'No backup target assigned.' });
    expect(out.classes.find((c) => c.backupClass === 'system')).toMatchObject({ healthy: false, healthDetail: 'No successful backup recorded yet.' });
  });
});

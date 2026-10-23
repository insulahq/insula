/**
 * Target storage measurements, stored and read back through real Postgres:
 * one row per target, the "measuring" state tied to a live lease, and a
 * second measurement of the same target refused while the first runs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { backupConfigurations } from '../../db/schema.js';
import { encrypt } from '../oidc/crypto.js';
import { isMeasuring, listTargetFileTimes, listTargetUsage, measureAndStore, type RcloneRunner } from './target-usage.js';

const dbAvailable = await isDbAvailable();
const KEY = 'a'.repeat(64);
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe.skipIf(!dbAvailable)('target usage (integration)', () => {
  const db = () => getTestDb();
  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql`DELETE FROM platform_settings WHERE setting_key LIKE 'backup\\_target\\_usage%' OR setting_key LIKE 'scheduler-lease:backup-target-usage%'`);
    await db().execute(sql.raw('DELETE FROM backup_target_assignments'));
    await db().execute(sql.raw('DELETE FROM backup_configurations'));
    await db().insert(backupConfigurations).values({
      id: 't-box', name: 'Box', storageType: 'cifs', cifsHost: 'box.example.test', cifsShare: 'backup', cifsUser: 'u',
      cifsPasswordEncrypted: encrypt('p', KEY), cifsPath: 'insula', enabled: 1,
    } as typeof backupConfigurations.$inferInsert);
  });

  const fake = (): RcloneRunner => async (args) => {
    const where = args[args.length - 1];
    if (args[0] === 'about') return { code: 0, stdout: '{"total":1000,"used":400,"free":600}', stderr: '' };
    if (args[0] === 'lsf') return { code: 0, stdout: 'tenant/\n', stderr: '' };
    if (where.endsWith('/tenant')) return { code: 0, stdout: '{"count":2,"bytes":300}', stderr: '' };
    return { code: 3, stdout: '', stderr: 'directory not found' };
  };

  it('stores a measurement and reads it back on the target', async () => {
    const usage = await measureAndStore({ db: db(), encryptionKey: KEY, log, run: fake() }, 't-box');
    expect(usage?.usedByBackupsBytes).toBe(300);
    const [row] = await listTargetUsage(db());
    expect(row.targetId).toBe('t-box');
    expect(row.usage?.classes.tenant).toEqual({ bytes: 300, objects: 2 });
    expect(row.usage?.capacity).toEqual({ totalBytes: 1000, usedBytes: 400, freeBytes: 600 });
    expect(row.measuringSince).toBeNull();
    expect(await isMeasuring(db(), 't-box')).toBe(false);
  });

  it('is "measuring" only while the lease is live — a dead replica frees it within minutes', async () => {
    await db().execute(sql`INSERT INTO platform_settings (setting_key, setting_value) VALUES
      ('backup_target_usage_measuring:t-box', ${new Date(Date.now() - 60_000).toISOString()}),
      ('scheduler-lease:backup-target-usage:t-box', json_build_object('holder','other-replica','until', now() + interval '5 minutes')::text)`);
    expect((await listTargetUsage(db()))[0].measuringSince).not.toBeNull();
    expect(await isMeasuring(db(), 't-box')).toBe(true);
    // A second measurement while the first runs does nothing.
    expect(await measureAndStore({ db: db(), encryptionKey: KEY, log, run: fake() }, 't-box')).toBeNull();

    // The holder died: its lease lapsed. The marker it left is ignored.
    await db().execute(sql`UPDATE platform_settings SET setting_value = json_build_object('holder','other-replica','until', now() - interval '1 minute')::text
      WHERE setting_key = 'scheduler-lease:backup-target-usage:t-box'`);
    expect((await listTargetUsage(db()))[0].measuringSince).toBeNull();
    expect(await isMeasuring(db(), 't-box')).toBe(false);
    expect(await measureAndStore({ db: db(), encryptionKey: KEY, log, run: fake() }, 't-box')).not.toBeNull();
  });

  it('reads real file times from the class\'s own target, keyed as the shim keys them', async () => {
    await db().execute(sql`INSERT INTO backup_target_assignments (backup_class, target_id, priority) VALUES ('system', 't-box', 0)`);
    const calls: string[][] = [];
    const run: RcloneRunner = async (args) => {
      calls.push([...args]);
      return { code: 0, stderr: '', stdout: JSON.stringify([
        { Path: '0000000100000000/000000010000000000000001.gz', ModTime: '2026-10-19T03:00:12.5+00:00', IsDir: false },
        { Path: 'broken', IsDir: false },
      ]) };
    };
    const times = await listTargetFileTimes(db(), KEY, 'system', 'postgres/system-db/wals/', { run });
    expect(calls[0]).toContain('usage:backup/insula/system/postgres/system-db/wals');
    expect(calls[0]).toContain('--use-server-modtime');
    expect([...times!.entries()]).toEqual([
      ['postgres/system-db/wals/0000000100000000/000000010000000000000001.gz', '2026-10-19T03:00:12.500Z'],
    ]);
    // No target bound to the class: no times, not a guess.
    expect(await listTargetFileTimes(db(), KEY, 'mail', 'x', { run })).toBeNull();
    // A listing that fails: no times.
    expect(await listTargetFileTimes(db(), KEY, 'system', 'x', { run: async () => ({ code: 1, stdout: '', stderr: 'boom' }) })).toBeNull();
  });

  it('an unknown target is null, not a throw', async () => {
    expect(await measureAndStore({ db: db(), encryptionKey: KEY, log, run: fake() }, 'nope')).toBeNull();
  });
});

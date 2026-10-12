/**
 * The automatic archive/delete settings against a REAL Postgres: what is
 * stored, what an unusable row reads as, and the record of the last run.
 *
 * Needs a database — CI's integration job provides DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { TenantAutomationRun } from '@insula/api-contracts';
import type { Database } from '../../../db/index.js';
import {
  loadAutomationRunRecord,
  loadTenantAutomationSettings,
  saveAutomationRun,
  saveTenantAutomationSettings,
} from './settings.js';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('tenant automation settings (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=tenant_automation_test' });
    await pool.query('DROP SCHEMA IF EXISTS tenant_automation_test CASCADE');
    await pool.query('CREATE SCHEMA tenant_automation_test');
    await pool.query(`CREATE TABLE platform_settings (setting_key varchar(100) PRIMARY KEY, setting_value text NOT NULL,
      updated_at timestamp NOT NULL DEFAULT now())`);
    db = drizzle(pool) as unknown as Database;
  });

  afterAll(async () => {
    await pool?.query('DROP SCHEMA IF EXISTS tenant_automation_test CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE platform_settings');
  });

  const rows = async (): Promise<Record<string, string>> => Object.fromEntries(
    (await pool.query('SELECT setting_key, setting_value FROM platform_settings ORDER BY 1')).rows
      .map((r: { setting_key: string; setting_value: string }) => [r.setting_key, r.setting_value]),
  );
  const put = (key: string, value: string) => pool.query(
    'INSERT INTO platform_settings (setting_key, setting_value) VALUES ($1, $2) ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2', [key, value],
  );

  it('an install that never touched them runs with both steps off, 30 and 90 days', async () => {
    expect(await loadTenantAutomationSettings(db)).toEqual({
      autoArchiveEnabled: false, autoArchiveAfterDays: 30, autoDeleteEnabled: false, autoDeleteAfterDays: 90,
    });
  });

  it('saves what it is given under the keys the sweep has always read, and leaves the rest alone', async () => {
    const after = await saveTenantAutomationSettings(db, { autoArchiveEnabled: true, autoArchiveAfterDays: 14 });
    expect(after).toEqual({ autoArchiveEnabled: true, autoArchiveAfterDays: 14, autoDeleteEnabled: false, autoDeleteAfterDays: 90 });
    expect(await rows()).toEqual({
      'tenant_lifecycle.auto_archive_enabled': 'true',
      'tenant_lifecycle.auto_archive_after_days': '14',
    });
    await saveTenantAutomationSettings(db, { autoArchiveEnabled: false });
    expect(await loadTenantAutomationSettings(db)).toMatchObject({ autoArchiveEnabled: false, autoArchiveAfterDays: 14 });
  });

  it('a save is all or nothing: a switch is never stored without the limit that came with it', async () => {
    await saveTenantAutomationSettings(db, { autoDeleteEnabled: false, autoDeleteAfterDays: 90 });
    // The second row's write fails. Outside one transaction the first —
    // "delete on" — would stand, with the old 90 days beside it.
    let writes = 0;
    const failing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'transaction') return Reflect.get(target, prop, receiver);
        return (fn: (tx: unknown) => Promise<unknown>) => target.transaction((tx) => fn(new Proxy(tx, {
          get(t, p, r) {
            if (p === 'insert') {
              writes += 1;
              if (writes === 2) throw new Error('connection lost');
            }
            const value = Reflect.get(t, p, r);
            return typeof value === 'function' ? value.bind(t) : value;
          },
        })));
      },
    }) as Database;
    await expect(saveTenantAutomationSettings(failing, { autoDeleteEnabled: true, autoDeleteAfterDays: 365 })).rejects.toThrow('connection lost');
    expect(writes).toBe(2);
    expect(await loadTenantAutomationSettings(db)).toMatchObject({ autoDeleteEnabled: false, autoDeleteAfterDays: 90 });
  });

  it.each(['0', '-3', 'abc', '1.5', '3651', '', ' '])('a stored limit of %j is not used: the default is, and it says so', async (bad) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await put('tenant_lifecycle.auto_archive_after_days', bad);
      await put('tenant_lifecycle.auto_delete_after_days', bad);
      expect(await loadTenantAutomationSettings(db)).toMatchObject({ autoArchiveAfterDays: 30, autoDeleteAfterDays: 90 });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it.each(['TRUE', '1', 'yes', 'on', ''])('only the exact string "true" switches a step on — %j does not', async (value) => {
    await put('tenant_lifecycle.auto_archive_enabled', value);
    await put('tenant_lifecycle.auto_delete_enabled', value);
    expect(await loadTenantAutomationSettings(db)).toMatchObject({ autoArchiveEnabled: false, autoDeleteEnabled: false });
  });

  it.each([
    [{ autoArchiveAfterDays: 0 }, 'autoArchiveAfterDays'],
    [{ autoDeleteAfterDays: 3651 }, 'autoDeleteAfterDays'],
    [{ autoDeleteAfterDays: 1.5 }, 'autoDeleteAfterDays'],
    [{ autoArchiveEnabled: 'true' }, 'autoArchiveEnabled'],
  ])('refuses %j and writes nothing', async (input, field) => {
    await expect(saveTenantAutomationSettings(db, input as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400, details: { field } });
    expect(await rows()).toEqual({});
  });

  it('refuses a field it does not know, and an empty change', async () => {
    await expect(saveTenantAutomationSettings(db, { autoArchiveEnabled: true, autoPurgeEnabled: true } as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(saveTenantAutomationSettings(db, {})).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: 'Nothing to change' });
    expect(await rows()).toEqual({});
  });

  const run = (over: Partial<TenantAutomationRun>): TenantAutomationRun => ({
    startedAt: '2026-06-15T12:00:00.000Z', finishedAt: '2026-06-15T12:03:00.000Z', trigger: 'schedule',
    archived: [{ tenantId: 'a', name: 'A' }], deleted: [], failed: [], archiveSkippedReason: null, errors: [], ...over,
  });

  it('no run yet reads as none', async () => {
    expect(await loadAutomationRunRecord(db)).toEqual({ lastRun: null, lastScheduledAt: null });
  });

  it('remembers the last run; only the schedule\'s own run moves the time the next one is counted from', async () => {
    const scheduled = run({});
    await saveAutomationRun(db, scheduled);
    expect(await loadAutomationRunRecord(db)).toEqual({ lastRun: scheduled, lastScheduledAt: '2026-06-15T12:00:00.000Z' });

    const manual = run({ startedAt: '2026-06-15T15:00:00.000Z', finishedAt: '2026-06-15T15:00:05.000Z', trigger: 'manual', archived: [] });
    await saveAutomationRun(db, manual);
    expect(await loadAutomationRunRecord(db)).toEqual({ lastRun: manual, lastScheduledAt: '2026-06-15T12:00:00.000Z' });
  });

  it('a record that cannot be read is no record, not an error on the page', async () => {
    await put('tenant_lifecycle.automation_last_run', '{not json');
    await put('tenant_lifecycle.automation_last_scheduled_at', 'yesterday-ish');
    expect(await loadAutomationRunRecord(db)).toEqual({ lastRun: null, lastScheduledAt: null });
    await put('tenant_lifecycle.automation_last_run', JSON.stringify({ startedAt: 'x' }));
    expect((await loadAutomationRunRecord(db)).lastRun).toBeNull();
  });
});

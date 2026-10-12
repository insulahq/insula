/**
 * The tenant's lock against a REAL Postgres: one start or delete per tenant
 * at a time, on any replica.
 *
 * "Another replica" is a lease row written under another holder's name.
 *
 * Needs a database — CI's integration job provides DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { ApiError } from '../../shared/errors.js';
import { RUN_LOCK_TTL_MS, runLockName } from '../../shared/exclusive-run.js';
import { __setLeaseTimingForTests, claimSchedulerLease, releaseSchedulerLease } from '../../shared/scheduler-lease.js';
import { tenantLockJob, withTenantLock } from './tenant-lock.js';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('tenant lock (real Postgres)', () => {
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=tenant_lock_test' });
    await pool.query('DROP SCHEMA IF EXISTS tenant_lock_test CASCADE');
    await pool.query('CREATE SCHEMA tenant_lock_test');
    await pool.query(`CREATE TABLE platform_settings (setting_key varchar(100) PRIMARY KEY, setting_value text NOT NULL,
      updated_at timestamp NOT NULL DEFAULT now())`);
    db = drizzle(pool);
  });

  afterAll(async () => {
    await pool?.query('DROP SCHEMA IF EXISTS tenant_lock_test CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE platform_settings');
    __setLeaseTimingForTests(null);
  });

  const T1 = '11111111-1111-4111-8111-111111111111';
  const T2 = '22222222-2222-4222-8222-222222222222';
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
  const lockRows = async (): Promise<number> => (await pool.query('SELECT 1 FROM platform_settings')).rowCount ?? 0;
  const heldElsewhere = async (tenantId: string): Promise<() => Promise<void>> => {
    const lock = runLockName(tenantLockJob(tenantId));
    expect(await claimSchedulerLease(db, lock, RUN_LOCK_TTL_MS, 'replica-b')).toBe(true);
    return () => releaseSchedulerLease(db, lock, 'replica-b');
  };

  it('its key fits the settings table\'s 100 characters, for any tenant id', () => {
    expect(`scheduler-lease:${runLockName(tenantLockJob(T1))}`.length).toBeLessThanOrEqual(100);
  });

  it('two changes to one tenant run one after the other, never together', async () => {
    const order: string[] = [];
    const first = withTenantLock(db, T1, async () => { order.push('a starts'); await sleep(600); order.push('a ends'); return 'a'; });
    await sleep(100);
    const second = withTenantLock(db, T1, async () => { order.push('b starts'); return 'b'; });
    expect(await Promise.all([first, second])).toEqual(['a', 'b']);
    expect(order).toEqual(['a starts', 'a ends', 'b starts']);
    expect(await lockRows()).toBe(0);
  });

  it('a change to another tenant does not wait', async () => {
    let finish: () => void = () => {};
    const slow = withTenantLock(db, T1, () => new Promise<void>((resolve) => { finish = resolve; }));
    await sleep(100);
    expect(await withTenantLock(db, T2, async () => 'through', { waitMs: 0 })).toBe('through');
    finish();
    await slow;
  });

  it('a delete under way on another replica is waited for, then the start sees the tenant as the delete left it', async () => {
    const finish = await heldElsewhere(T1);
    let sawAfter = false;
    let deleteDone = false;
    const start = withTenantLock(db, T1, async () => { sawAfter = deleteDone; });
    await sleep(700);
    deleteDone = true;
    await finish();
    await start;
    expect(sawAfter).toBe(true);
  });

  it('still busy after the wait: 409 TENANT_BUSY, nothing done, and the words to show for it', async () => {
    const finish = await heldElsewhere(T1);
    let calls = 0;
    const refused = await withTenantLock(db, T1, async () => { calls += 1; }, { waitMs: 300 }).then(() => null, (err: unknown) => err);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({
      code: 'TENANT_BUSY', status: 409,
      details: { tenantId: T1, operatorError: { code: 'TENANT_BUSY', title: 'Tenant is busy', retryable: true } },
    });
    expect((refused as ApiError).details).toMatchObject({ operatorError: { remediation: [expect.stringContaining('Nothing was changed by this request')] } });
    expect(calls).toBe(0);
    await finish();
  });

  it('a change that fails gives the lock back', async () => {
    await expect(withTenantLock(db, T1, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await lockRows()).toBe(0);
    expect(await withTenantLock(db, T1, async () => 'next', { waitMs: 0 })).toBe('next');
  });
});

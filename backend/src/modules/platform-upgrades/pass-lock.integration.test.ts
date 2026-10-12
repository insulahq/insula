/**
 * The upgrade reconciler's pass lock against a REAL Postgres: a pass that
 * outlives the 7-second per-tick claim must not be joined by another replica.
 *
 * Needs a database — CI's integration job provides DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import { withUpgradePassLock } from './scheduler.js';

const url = process.env.LEASE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!url)('upgrade pass lock (real Postgres)', () => {
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=upgrade_pass_lock_test' });
    await pool.query('DROP SCHEMA IF EXISTS upgrade_pass_lock_test CASCADE');
    await pool.query('CREATE SCHEMA upgrade_pass_lock_test');
    await pool.query(`CREATE TABLE platform_settings (setting_key varchar(100) PRIMARY KEY, setting_value text NOT NULL,
      updated_at timestamp NOT NULL DEFAULT now())`);
    db = drizzle(pool);
  });
  afterAll(async () => {
    await pool?.query('DROP SCHEMA IF EXISTS upgrade_pass_lock_test CASCADE');
    await pool?.end();
  });
  beforeEach(async () => { await pool.query('TRUNCATE platform_settings'); });

  it('a pass in flight on one replica is not joined by another; the next pass runs once it ends', async () => {
    let finish: () => void = () => {};
    const slow = new Promise<void>((r) => { finish = r; });
    let passes = 0;
    // "Another replica" is a different lease holder: the same lock, taken by someone else.
    const other = withSchedulerLease(db, 'platform-upgrade-pass', 60_000, async () => { passes += 1; await slow; },
      { holder: 'other-replica', release: true });
    await new Promise((r) => setTimeout(r, 150));

    const joined = await withUpgradePassLock(db, async () => { passes += 1; });
    expect(joined.ran).toBe(false);
    expect(passes).toBe(1);

    finish();
    await other;
    const next = await withUpgradePassLock(db, async () => { passes += 1; });
    expect(next.ran).toBe(true);
    expect(passes).toBe(2);
  });

  it('the lock is gone as soon as a pass ends, also when the pass throws', async () => {
    await expect(withUpgradePassLock(db, async () => { throw new Error('advance failed'); })).rejects.toThrow('advance failed');
    const left = await pool.query(`SELECT count(*)::int AS n FROM platform_settings WHERE setting_key = 'scheduler-lease:platform-upgrade-pass'`);
    expect(left.rows[0].n).toBe(0);
  });
});

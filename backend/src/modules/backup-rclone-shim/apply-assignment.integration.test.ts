/**
 * The reconcile a backup-target change runs at once, against a REAL Postgres:
 * it takes the shim reconciler's run lock, waits for a pass under way — and
 * when the lock is still not free after the wait, reports that as a failed
 * reconcile without rendering anything.
 *
 * "Another replica" is a lease row written under another holder's name.
 *
 * Needs a database — CI's integration job provides DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Database } from '../../db/index.js';
import { RUN_LOCK_TTL_MS, runLockName } from '../../shared/exclusive-run.js';
import { __setLeaseTimingForTests, claimSchedulerLease, releaseSchedulerLease } from '../../shared/scheduler-lease.js';
import { reconcileShimAfterChange, type ShimReconcileOutcome } from './apply-assignment.js';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('reconcile after a backup-target change (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Database;
  const LOCK = runLockName('backup-rclone-shim');

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=shim_apply_test' });
    await pool.query('DROP SCHEMA IF EXISTS shim_apply_test CASCADE');
    await pool.query('CREATE SCHEMA shim_apply_test');
    await pool.query(`CREATE TABLE platform_settings (setting_key varchar(100) PRIMARY KEY, setting_value text NOT NULL,
      updated_at timestamp NOT NULL DEFAULT now())`);
    db = drizzle(pool) as unknown as Database;
  });

  afterAll(async () => {
    await pool?.query('DROP SCHEMA IF EXISTS shim_apply_test CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE platform_settings');
    __setLeaseTimingForTests(null);
  });

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
  const lockRows = async (): Promise<number> => (await pool.query('SELECT 1 FROM platform_settings')).rowCount ?? 0;
  const OK: ShimReconcileOutcome = { state: 'STATE_OK', errorMessage: '' };

  it('with the lock free: renders at once, under the lock, and gives it back', async () => {
    let heldDuring = 0;
    const outcome = await reconcileShimAfterChange(db, async () => { heldDuring = await lockRows(); return OK; }, undefined);
    expect(outcome).toEqual(OK);
    expect(heldDuring).toBe(1);
    expect(await lockRows()).toBe(0);
  });

  it('a pass under way on another replica is waited for; this one renders after it, so it reads the new binding', async () => {
    expect(await claimSchedulerLease(db, LOCK, RUN_LOCK_TTL_MS, 'replica-b')).toBe(true);
    const order: string[] = [];
    const pending = reconcileShimAfterChange(db, async () => { order.push('ours'); return OK; }, undefined, { waitMs: 10_000 });
    await sleep(700);
    expect(order).toEqual([]);
    order.push('theirs ended');
    await releaseSchedulerLease(db, LOCK, 'replica-b');
    expect(await pending).toEqual(OK);
    expect(order).toEqual(['theirs ended', 'ours']);
  });

  it('still busy after the wait: nothing is rendered, and it reads as a failed reconcile that says why', async () => {
    expect(await claimSchedulerLease(db, LOCK, RUN_LOCK_TTL_MS, 'replica-b')).toBe(true);
    let calls = 0;
    const outcome = await reconcileShimAfterChange(db, async () => { calls += 1; return OK; }, undefined, { waitMs: 400 });
    expect(outcome).toEqual({ state: 'STATE_ERROR', errorMessage: 'another shim reconcile was still running' });
    expect(calls).toBe(0);
    // The other replica's lock is untouched.
    expect(await claimSchedulerLease(db, LOCK, 1_000, 'replica-c')).toBe(false);
  });

  it('the reconciler\'s own verdict passes through unchanged, and a throw frees the lock', async () => {
    const missing: ShimReconcileOutcome = { state: 'STATE_MISSING_KEY', errorMessage: 'no key' };
    expect(await reconcileShimAfterChange(db, async () => missing, undefined)).toEqual(missing);
    await expect(reconcileShimAfterChange(db, async () => { throw new Error('boom'); }, undefined)).rejects.toThrow('boom');
    expect(await lockRows()).toBe(0);
  });
});

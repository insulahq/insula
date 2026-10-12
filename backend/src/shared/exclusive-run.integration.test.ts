/**
 * The run lock against a REAL Postgres: one run of a leased job's work at a
 * time, whether its timer started it or a request did, on any replica.
 *
 * "Another replica" is a lease row written under another holder's name.
 *
 * Needs a database — CI's integration job provides DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { ApiError } from './errors.js';
import { RUN_LOCK_TTL_MS, runExclusive, runExclusiveOrBusy, runLockName } from './exclusive-run.js';
import {
  __setLeaseTimingForTests,
  claimSchedulerLease,
  releaseSchedulerLease,
  withSchedulerLease,
} from './scheduler-lease.js';

const url = process.env.LEASE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!url)('run lock (real Postgres)', () => {
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=exclusive_run_test' });
    await pool.query('DROP SCHEMA IF EXISTS exclusive_run_test CASCADE');
    await pool.query('CREATE SCHEMA exclusive_run_test');
    await pool.query(`CREATE TABLE platform_settings (setting_key varchar(100) PRIMARY KEY, setting_value text NOT NULL,
      updated_at timestamp NOT NULL DEFAULT now())`);
    db = drizzle(pool);
  });

  afterAll(async () => {
    await pool?.query('DROP SCHEMA IF EXISTS exclusive_run_test CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE platform_settings');
    __setLeaseTimingForTests(null);
  });

  const lockRows = async (job: string): Promise<number> =>
    (await pool.query('SELECT 1 FROM platform_settings WHERE setting_key = $1', [`scheduler-lease:${runLockName(job)}`])).rowCount ?? 0;
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
  /** A run on another replica: it holds the lock until `finish()`. */
  const runElsewhere = async (job: string): Promise<() => Promise<void>> => {
    expect(await claimSchedulerLease(db, runLockName(job), RUN_LOCK_TTL_MS, 'replica-b')).toBe(true);
    return () => releaseSchedulerLease(db, runLockName(job), 'replica-b');
  };

  it('runs the work, and the lock is free again when it ends', async () => {
    const run = await runExclusive(db, 'job', async () => {
      expect(await lockRows('job')).toBe(1);
      return 'done';
    });
    expect(run).toEqual({ ran: true, value: 'done' });
    expect(await lockRows('job')).toBe(0);
  });

  it('a tick does not wait: while another replica runs the work, it is skipped', async () => {
    const finish = await runElsewhere('job');
    let calls = 0;
    expect(await runExclusive(db, 'job', async () => { calls += 1; })).toEqual({ ran: false });
    expect(calls).toBe(0);
    await finish();
  });

  it('a run started by a request waits for the run under way, then runs', async () => {
    const finish = await runElsewhere('job');
    const order: string[] = [];
    const waiting = runExclusive(db, 'job', async () => { order.push('ours'); return 7; }, { waitMs: 10_000 });
    await sleep(700);
    expect(order).toEqual([]);            // still waiting: the other run has not finished
    order.push('theirs ended');
    await finish();
    expect(await waiting).toEqual({ ran: true, value: 7 });
    expect(order).toEqual(['theirs ended', 'ours']);
  });

  it('gives up when the other run outlasts the wait — the work is not started beside it', async () => {
    const finish = await runElsewhere('job');
    let calls = 0;
    const started = performance.now();
    expect(await runExclusive(db, 'job', async () => { calls += 1; }, { waitMs: 900 })).toEqual({ ran: false });
    expect(performance.now() - started).toBeGreaterThanOrEqual(850);
    expect(calls).toBe(0);
    await finish();
  });

  it('a lock left by a replica that died is taken once it has run out', async () => {
    await runElsewhere('job');
    await pool.query(
      `UPDATE platform_settings SET setting_value = jsonb_set(setting_value::jsonb, '{until}', to_jsonb(now() - interval '1 second'))::text
        WHERE setting_key = $1`, [`scheduler-lease:${runLockName('job')}`],
    );
    expect((await runExclusive(db, 'job', async () => 'ours')).ran).toBe(true);
  });

  it('two runs in one process never overlap; with a wait the second follows the first', async () => {
    let running = 0;
    let overlap = false;
    const work = (label: string) => async (): Promise<string> => {
      running += 1;
      if (running > 1) overlap = true;
      await sleep(300);
      running -= 1;
      return label;
    };
    const first = runExclusive(db, 'job', work('first'));
    const refused = await runExclusive(db, 'job', work('refused'));
    const second = runExclusive(db, 'job', work('second'), { waitMs: 10_000 });

    expect(refused).toEqual({ ran: false });
    expect(await first).toEqual({ ran: true, value: 'first' });
    expect(await second).toEqual({ ran: true, value: 'second' });
    expect(overlap).toBe(false);
  });

  it('a run that hangs stops renewing after its longest hold: another replica takes the work, and the late run leaves that lock alone', async () => {
    let finish: () => void = () => {};
    const warnings: string[] = [];
    // Renewed every 500 ms (a third of the ttl), for 600 ms at most: the last
    // renewal is the one at 500 ms, so the lock runs out at about 2 s.
    const hung = runExclusive(db, 'job', () => new Promise<string>((resolve) => { finish = () => resolve('late'); }), {
      ttlMs: 1500,
      maxHoldMs: 600,
      log: { warn: (_obj, msg) => { warnings.push(String(msg)); } },
    });

    await sleep(1300);
    expect(await claimSchedulerLease(db, runLockName('job'), 60_000, 'replica-b')).toBe(false);   // still held
    await sleep(1500);
    expect(await claimSchedulerLease(db, runLockName('job'), 60_000, 'replica-b')).toBe(true);    // run out: theirs now
    expect(warnings.filter((w) => w.includes('no longer renewed'))).toHaveLength(1);              // said once, not per tick

    // The hung run comes back after all. Its release must not take replica-b's lock away.
    finish();
    expect(await hung).toEqual({ ran: true, value: 'late' });
    expect(await claimSchedulerLease(db, runLockName('job'), 60_000, 'replica-c')).toBe(false);
  }, 15_000);

  it('a failure of the work is thrown, and frees the lock', async () => {
    await expect(runExclusive(db, 'job', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await lockRows('job')).toBe(0);
    expect((await runExclusive(db, 'job', async () => 'next')).ran).toBe(true);
  });

  it('jobs do not block each other', async () => {
    const finish = await runElsewhere('one');
    expect((await runExclusive(db, 'two', async () => 'ok')).ran).toBe(true);
    await finish();
  });

  it('the timer keeps its sticky lease when the work is busy: the tick is skipped, not the job handed over', async () => {
    const finish = await runElsewhere('job');
    let calls = 0;
    const tick = () => withSchedulerLease(db, 'job', 60_000, () => runExclusive(db, 'job', async () => { calls += 1; }));

    expect(await tick()).toEqual({ ran: true, value: { ran: false } });
    expect(calls).toBe(0);
    // Still this replica's job on the next tick, and now the work is free.
    await finish();
    expect(await tick()).toEqual({ ran: true, value: { ran: true, value: undefined } });
    expect(calls).toBe(1);
  });

  it('a request that wants the result gets it, or a 409 that names the job', async () => {
    expect(await runExclusiveOrBusy(db, 'job', 'The check', async () => 42)).toBe(42);

    const finish = await runElsewhere('job');
    const refused = await runExclusiveOrBusy(db, 'job', 'The check', async () => 42, { waitMs: 300 }).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({
      code: 'JOB_ALREADY_RUNNING',
      status: 409,
      details: {
        job: 'job',
        // What the panels render: a title, what happened, and that nothing was started.
        operatorError: { code: 'JOB_ALREADY_RUNNING', title: 'Already running', retryable: true },
      },
    });
    expect((refused as ApiError).message).toMatch(/^The check is already running/);
    const shown = (refused as ApiError).details!.operatorError as { detail: string; remediation: string[] };
    expect(shown.detail).toMatch(/^The check is already running/);
    expect(shown.remediation.join(' ')).toContain('Nothing was started by this request');
    await finish();
  });
});

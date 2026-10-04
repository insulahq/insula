/**
 * The scheduler lease against a REAL Postgres: HA runs three platform-api
 * replicas, and every scheduled job must run on one of them at a time. Times
 * are the database's own, so these tests move the clock by rewriting `until`.
 *
 * Needs a database — CI's integration job provides DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  claimSchedulerLease,
  releaseAllSchedulerLeases,
  releaseSchedulerLease,
  runningSchedulerJobs,
  withSchedulerLease,
} from './scheduler-lease.js';

const url = process.env.LEASE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!url)('scheduler lease (real Postgres)', () => {
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=scheduler_lease_test' });
    await pool.query('DROP SCHEMA IF EXISTS scheduler_lease_test CASCADE');
    await pool.query('CREATE SCHEMA scheduler_lease_test');
    await pool.query(`CREATE TABLE platform_settings (setting_key varchar(100) PRIMARY KEY, setting_value text NOT NULL,
      updated_at timestamp NOT NULL DEFAULT now())`);
    db = drizzle(pool);
  });

  afterAll(async () => {
    await pool?.query('DROP SCHEMA IF EXISTS scheduler_lease_test CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE platform_settings');
  });

  const expire = (job: string) => pool.query(
    `UPDATE platform_settings SET setting_value = jsonb_set(setting_value::jsonb, '{until}', to_jsonb(now() - interval '1 second'))::text
      WHERE setting_key = $1`, [`scheduler-lease:${job}`],
  );

  it('one holder at a time; the holder keeps it tick after tick', async () => {
    expect(await claimSchedulerLease(db, 'job', 60_000, 'replica-a')).toBe(true);
    expect(await claimSchedulerLease(db, 'job', 60_000, 'replica-b')).toBe(false);
    expect(await claimSchedulerLease(db, 'job', 60_000, 'replica-a')).toBe(true);
    expect(await claimSchedulerLease(db, 'job', 60_000, 'replica-c')).toBe(false);
  });

  it('another replica takes over once the holder stops renewing', async () => {
    await claimSchedulerLease(db, 'job', 60_000, 'replica-a');
    await expire('job');
    expect(await claimSchedulerLease(db, 'job', 60_000, 'replica-b')).toBe(true);
    expect(await claimSchedulerLease(db, 'job', 60_000, 'replica-a')).toBe(false);
  });

  it('simultaneous claims from three replicas: exactly one wins', async () => {
    const wins = await Promise.all(['a', 'b', 'c'].map((r) => claimSchedulerLease(db, 'race', 60_000, r)));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it('jobs are independent', async () => {
    expect(await claimSchedulerLease(db, 'one', 60_000, 'replica-a')).toBe(true);
    expect(await claimSchedulerLease(db, 'two', 60_000, 'replica-b')).toBe(true);
  });

  it.each([
    ['not json', 'not json'],
    ['json with a garbled until', '{"holder":"replica-z","until":"next tuesday"}'],
    ['json with no until', '{"holder":"replica-z"}'],
  ])('an unreadable row (%s) does not wedge the job forever', async (_label, value) => {
    await pool.query(`INSERT INTO platform_settings (setting_key, setting_value) VALUES ('scheduler-lease:job', $1)`, [value]);
    expect(await claimSchedulerLease(db, 'job', 60_000, 'replica-a')).toBe(true);
  });

  it('withSchedulerLease runs the job only on the holder', async () => {
    let runs = 0;
    const a = await withSchedulerLease(db, 'job', 60_000, async () => { runs += 1; return 'a'; }, { holder: 'replica-a' });
    const b = await withSchedulerLease(db, 'job', 60_000, async () => { runs += 1; return 'b'; }, { holder: 'replica-b' });
    expect(a).toEqual({ ran: true, value: 'a' });
    expect(b).toEqual({ ran: false });
    expect(runs).toBe(1);
  });

  it('a run lock is free again as soon as the run ends', async () => {
    await withSchedulerLease(db, 'sweep', 60_000, async () => undefined, { holder: 'replica-a', release: true });
    const b = await withSchedulerLease(db, 'sweep', 60_000, async () => 'b', { holder: 'replica-b', release: true });
    expect(b).toEqual({ ran: true, value: 'b' });
  });

  it('a run lock is held for the whole run, even past its ttl', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const running = withSchedulerLease(db, 'long', 1_500, () => gate, { holder: 'replica-a', release: true, renewEveryMs: 200 });
    await new Promise((r) => setTimeout(r, 2_500)); // longer than the ttl — renewals keep it
    expect(await claimSchedulerLease(db, 'long', 1_500, 'replica-b')).toBe(false);
    release();
    await running;
    expect(await claimSchedulerLease(db, 'long', 1_500, 'replica-b')).toBe(true);
  });

  it('shutdown keeps the lease of a job still running here — it is not started twice', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => { finish = r; });
    await claimSchedulerLease(db, 'idle', 60_000, 'replica-a');
    const running = withSchedulerLease(db, 'sweep', 60_000, () => gate, { holder: 'replica-a', release: true });
    await new Promise((r) => setTimeout(r, 100)); // claimed, fn in flight
    expect(runningSchedulerJobs()).toContain('sweep');

    expect(await releaseAllSchedulerLeases(db, 'replica-a')).toBe(1); // 'idle' only
    expect(await claimSchedulerLease(db, 'sweep', 60_000, 'replica-b')).toBe(false);
    expect(await claimSchedulerLease(db, 'idle', 60_000, 'replica-b')).toBe(true);
    finish();
    await running;
    expect(runningSchedulerJobs()).not.toContain('sweep');
  });

  it('only the holder can release; shutdown releases every lease it holds', async () => {
    await claimSchedulerLease(db, 'x', 60_000, 'replica-a');
    await claimSchedulerLease(db, 'y', 60_000, 'replica-a');
    await claimSchedulerLease(db, 'z', 60_000, 'replica-b');
    await releaseSchedulerLease(db, 'x', 'replica-b');
    expect(await claimSchedulerLease(db, 'x', 60_000, 'replica-b')).toBe(false);

    expect(await releaseAllSchedulerLeases(db, 'replica-a')).toBe(2);
    expect(await claimSchedulerLease(db, 'x', 60_000, 'replica-b')).toBe(true);
    expect(await claimSchedulerLease(db, 'y', 60_000, 'replica-b')).toBe(true);
    expect(await claimSchedulerLease(db, 'z', 60_000, 'replica-c')).toBe(false); // still replica-b's
  });
});

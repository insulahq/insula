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
  __setLeaseTimingForTests,
  claimSchedulerLease,
  LEASE_LIVENESS_MS,
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
    __setLeaseTimingForTests(null);
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

  // ── liveness: a holder that dies between runs frees a long lease within minutes ──
  const secondsLeft = async (job: string): Promise<number> => {
    const r = await pool.query(
      `SELECT extract(epoch FROM (setting_value::jsonb ->> 'until')::timestamptz - now()) AS s
         FROM platform_settings WHERE setting_key = $1`, [`scheduler-lease:${job}`],
    );
    return r.rows.length ? Number(r.rows[0].s) : Number.NaN;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const DAY = 24 * 60 * 60_000;

  it('while a daily job runs its lease covers the whole ttl; once it has run, only the liveness window', async () => {
    let during = 0;
    await withSchedulerLease(db, 'daily', 1.5 * DAY, async () => { during = await secondsLeft('daily'); }, { holder: 'replica-a' });
    expect(during).toBeGreaterThan(1.4 * DAY / 1000);
    const after = await secondsLeft('daily');
    expect(after).toBeGreaterThan(LEASE_LIVENESS_MS / 1000 - 30);
    expect(after).toBeLessThanOrEqual(LEASE_LIVENESS_MS / 1000);
  });

  it('a short job\'s lease is written for its own ttl, during and after the run', async () => {
    await withSchedulerLease(db, 'quick', 20_000, async () => undefined, { holder: 'replica-a' });
    const left = await secondsLeft('quick');
    expect(left).toBeGreaterThan(15);
    expect(left).toBeLessThanOrEqual(20);
  });

  it('a run lock is written for its whole ttl, not capped', async () => {
    let during = 0;
    await withSchedulerLease(db, 'sweep-run', 6 * 60 * 60_000, async () => { during = await secondsLeft('sweep-run'); },
      { holder: 'replica-a', release: true });
    expect(during).toBeGreaterThan(5.9 * 3600);
  });

  it('the holding process keeps a long lease alive between runs; another replica is refused all along', async () => {
    __setLeaseTimingForTests({ livenessMs: 1_200, keepAliveEveryMs: 250 });
    await withSchedulerLease(db, 'daily', 60_000, async () => undefined, { holder: 'replica-a' });
    for (let i = 0; i < 6; i++) {            // 3 s: more than two liveness windows
      await sleep(500);
      expect(await claimSchedulerLease(db, 'daily', 1_000, 'replica-b')).toBe(false);
    }
  });

  it('a holder that dies between runs loses the lease after the liveness window, not after the job\'s ttl', async () => {
    __setLeaseTimingForTests({ livenessMs: 1_200, keepAliveEveryMs: 250 });
    await withSchedulerLease(db, 'daily', 1.5 * DAY, async () => undefined, { holder: 'replica-a' });
    __setLeaseTimingForTests({ livenessMs: 1_200, keepAliveEveryMs: 250 }); // the process is gone: nothing extends the lease
    expect(await claimSchedulerLease(db, 'daily', 1_000, 'replica-b')).toBe(false);
    await sleep(1_500);
    expect(await claimSchedulerLease(db, 'daily', 1_000, 'replica-b')).toBe(true);
  });

  it('a live process that stops ticking a job keeps its lease only for the job\'s ttl', async () => {
    __setLeaseTimingForTests({ livenessMs: 600, keepAliveEveryMs: 150 });
    await withSchedulerLease(db, 'stalled', 1_500, async () => undefined, { holder: 'replica-a' });
    await sleep(900);                         // past one liveness window, inside the ttl: still ours
    expect(await claimSchedulerLease(db, 'stalled', 1_000, 'replica-b')).toBe(false);
    await sleep(2_100);                       // past the ttl (a lease is never shorter than 1 s): the keep-alive has let go
    expect(await claimSchedulerLease(db, 'stalled', 1_000, 'replica-b')).toBe(true);
  });

  it('a released lease is not taken back by the keep-alive', async () => {
    __setLeaseTimingForTests({ livenessMs: 1_200, keepAliveEveryMs: 200 });
    await withSchedulerLease(db, 'daily', 60_000, async () => undefined, { holder: 'replica-a' });
    expect(await releaseAllSchedulerLeases(db, 'replica-a')).toBe(1);
    await sleep(700);                         // three keep-alive periods
    expect(await claimSchedulerLease(db, 'daily', 1_000, 'replica-b')).toBe(true);
  });

  it('a keep-alive already on its way when the lease is released does not write it back', async () => {
    // A database whose keep-alive claims arrive late: the release must wait for
    // the one in flight, or its DELETE runs first and the claim re-creates the row.
    let slow = false;
    const laggy = { execute: async (q: Parameters<typeof db.execute>[0]) => { if (slow) await sleep(400); return db.execute(q); } };
    __setLeaseTimingForTests({ livenessMs: 5_000, keepAliveEveryMs: 200 });
    await withSchedulerLease(laggy, 'daily', 60_000, async () => undefined, { holder: 'replica-a' });
    slow = true;
    await sleep(300);                         // a keep-alive claim has been sent and is still on its way
    slow = false;
    expect(await releaseAllSchedulerLeases(db, 'replica-a')).toBe(1);
    await sleep(600);
    expect(await claimSchedulerLease(db, 'daily', 1_000, 'replica-b')).toBe(true);
  });

  it('a job already running in this process is not started again by its next tick', async () => {
    let finish: () => void = () => {};
    const running = new Promise<void>((r) => { finish = r; });
    let runs = 0;
    const first = withSchedulerLease(db, 'slow', 60_000, async () => { runs += 1; await running; }, { holder: 'replica-a' });
    await sleep(100);
    const second = await withSchedulerLease(db, 'slow', 60_000, async () => { runs += 1; }, { holder: 'replica-a' });
    expect(second.ran).toBe(false);
    finish();
    await first;
    expect(runs).toBe(1);
    expect((await withSchedulerLease(db, 'slow', 60_000, async () => { runs += 1; }, { holder: 'replica-a' })).ran).toBe(true);
  });

  it('a keep-alive claim never cuts a longer lease of the same holder back (a run that just started wrote it)', async () => {
    await claimSchedulerLease(db, 'daily', 60_000, 'replica-a');
    expect(await claimSchedulerLease(db, 'daily', 5_000, 'replica-a', { extendOnly: true })).toBe(true); // still ours
    expect(await secondsLeft('daily')).toBeGreaterThan(50);
    expect(await claimSchedulerLease(db, 'daily', 90_000, 'replica-a', { extendOnly: true })).toBe(true);
    expect(await secondsLeft('daily')).toBeGreaterThan(80);                                              // extends
    expect(await claimSchedulerLease(db, 'daily', 5_000, 'replica-a')).toBe(true);                       // a plain claim may shorten
    expect(await secondsLeft('daily')).toBeLessThanOrEqual(5);
    expect(await claimSchedulerLease(db, 'daily', 5_000, 'replica-b', { extendOnly: true })).toBe(false); // and another holder gets nothing
  });

  it('the job counts as running here until its lease has been cut back: a tick in between is refused, not undone', async () => {
    let slow = false;
    const laggy = { execute: async (q: Parameters<typeof db.execute>[0]) => { if (slow) await sleep(400); return db.execute(q); } };
    let runs = 0;
    const first = withSchedulerLease(laggy, 'daily', 1.5 * DAY, async () => { runs += 1; slow = true; }, { holder: 'replica-a' });
    await sleep(150);                         // fn has returned; the cut-back claim is on its way
    slow = false;
    expect((await withSchedulerLease(db, 'daily', 1.5 * DAY, async () => { runs += 1; }, { holder: 'replica-a' })).ran).toBe(false);
    await first;
    expect(runs).toBe(1);
    expect(await secondsLeft('daily')).toBeLessThanOrEqual(LEASE_LIVENESS_MS / 1000);
    expect((await withSchedulerLease(db, 'daily', 1.5 * DAY, async () => { runs += 1; }, { holder: 'replica-a' })).ran).toBe(true);
  });

  // ── the start-up run that a rollout, or a crash, refuses ──────────────────
  it('rollout: a long job refused on its first tick runs on the next try, once the replaced process has given the lease up', async () => {
    __setLeaseTimingForTests({ startupDelayMs: 400, startupLastTryMs: 5_000 });
    await claimSchedulerLease(db, 'hourly', 5_000, 'replaced-process');
    let runs = 0;
    const first = await withSchedulerLease(db, 'hourly', 90 * 60_000, async () => { runs += 1; }, { holder: 'new-process' });
    expect(first.ran).toBe(false);
    await releaseSchedulerLease(db, 'hourly', 'replaced-process'); // the replaced process shuts down
    await sleep(900);
    expect(runs).toBe(1);
    expect(await claimSchedulerLease(db, 'hourly', 1_000, 'someone-else')).toBe(false); // and the new process holds it
  });

  it('crash: the dead holder\'s lease outlives the first later try; the last one runs the job', async () => {
    __setLeaseTimingForTests({ startupDelayMs: 300, startupLastTryMs: 1_600 });
    await claimSchedulerLease(db, 'hourly', 1_100, 'dead-process');   // nothing renews it
    let runs = 0;
    await withSchedulerLease(db, 'hourly', 90 * 60_000, async () => { runs += 1; }, { holder: 'new-process' });
    await sleep(700);
    expect(runs).toBe(0);                     // +300 ms: still the dead holder's
    await sleep(1_300);
    expect(runs).toBe(1);                     // +1.6 s: lapsed, taken, run
  });

  it('with another replica alive every later try is refused — and after the last there is no other', async () => {
    __setLeaseTimingForTests({ startupDelayMs: 200, startupLastTryMs: 600 });
    await claimSchedulerLease(db, 'hourly', 60_000, 'live-peer');
    let runs = 0;
    await withSchedulerLease(db, 'hourly', 90 * 60_000, async () => { runs += 1; }, { holder: 'new-process' });
    await sleep(1_000);                       // both later tries have come and gone
    await releaseSchedulerLease(db, 'hourly', 'live-peer');
    await sleep(900);
    expect(runs).toBe(0);
  });

  it('a short job gets no later try: its own next tick comes sooner', async () => {
    __setLeaseTimingForTests({ startupDelayMs: 300, startupLastTryMs: 600 });
    await claimSchedulerLease(db, 'five-minute', 5_000, 'replaced-process');
    let runs = 0;
    await withSchedulerLease(db, 'five-minute', 7.5 * 60_000, async () => { runs += 1; }, { holder: 'new-process' });
    await releaseSchedulerLease(db, 'five-minute', 'replaced-process');
    await sleep(900);
    expect(runs).toBe(0);
  });

  it('a refused run lock is never retried — a manual sweep refused now must not start by itself later', async () => {
    __setLeaseTimingForTests({ startupDelayMs: 300, startupLastTryMs: 600 });
    await claimSchedulerLease(db, 'sweep-run', 5_000, 'other');
    let runs = 0;
    await withSchedulerLease(db, 'sweep-run', 6 * 60 * 60_000, async () => { runs += 1; }, { holder: 'me', release: true });
    await releaseSchedulerLease(db, 'sweep-run', 'other');
    await sleep(900);
    expect(runs).toBe(0);
  });

  it('a start-up one-shot that opts out is not run later either', async () => {
    __setLeaseTimingForTests({ startupDelayMs: 300, startupLastTryMs: 600 });
    await claimSchedulerLease(db, 'boot-sweep', 5_000, 'first-replica');
    let runs = 0;
    await withSchedulerLease(db, 'boot-sweep', 30 * 60_000, async () => { runs += 1; }, { holder: 'second-replica', startupRetry: false });
    await releaseSchedulerLease(db, 'boot-sweep', 'first-replica');
    await sleep(900);
    expect(runs).toBe(0);
  });

  it('a later try whose claim fails (the database blinked) still leaves the last try owed', async () => {
    __setLeaseTimingForTests({ startupDelayMs: 300, startupLastTryMs: 1_500 });
    await claimSchedulerLease(db, 'hourly', 1_000, 'replaced-process'); // gone by the last try
    let failNext = false;
    const blinking = { execute: async (q: Parameters<typeof db.execute>[0]) => {
      if (failNext) { failNext = false; throw new Error('connection reset'); }
      return db.execute(q);
    } };
    let runs = 0;
    expect((await withSchedulerLease(blinking, 'hourly', 90 * 60_000, async () => { runs += 1; }, { holder: 'new-process' })).ran).toBe(false);
    failNext = true;                          // the first later try's claim throws
    await sleep(600);
    expect(runs).toBe(0);
    await sleep(1_400);
    expect(runs).toBe(1);                     // the last try made the run
  });

  it('a job that has meanwhile run here by its own tick is not run again by a later try', async () => {
    __setLeaseTimingForTests({ startupDelayMs: 500, startupLastTryMs: 900 });
    await claimSchedulerLease(db, 'ten-minute', 5_000, 'replaced-process');
    let runs = 0;
    const tick = () => withSchedulerLease(db, 'ten-minute', 15 * 60_000, async () => { runs += 1; }, { holder: 'new-process' });
    expect((await tick()).ran).toBe(false);
    await releaseSchedulerLease(db, 'ten-minute', 'replaced-process');
    expect((await tick()).ran).toBe(true);    // the job's own next tick
    await sleep(1_300);                       // both later tries have come and gone
    expect(runs).toBe(1);
  });

  it('a database that was down at the first tick does not use the later tries up', async () => {
    __setLeaseTimingForTests({ startupDelayMs: 300, startupLastTryMs: 5_000 });
    const down = { execute: async () => { throw new Error('connection refused'); } };
    let runs = 0;
    await expect(withSchedulerLease(down, 'hourly', 90 * 60_000, async () => { runs += 1; }, { holder: 'new-process' })).rejects.toThrow('connection refused');
    // The next tick is this process's first that got an answer: refused, so it earns the later try.
    await claimSchedulerLease(db, 'hourly', 5_000, 'replaced-process');
    expect((await withSchedulerLease(db, 'hourly', 90 * 60_000, async () => { runs += 1; }, { holder: 'new-process' })).ran).toBe(false);
    await releaseSchedulerLease(db, 'hourly', 'replaced-process');
    await sleep(800);
    expect(runs).toBe(1);
  });
});

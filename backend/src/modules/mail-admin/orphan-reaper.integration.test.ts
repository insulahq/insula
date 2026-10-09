/**
 * The mail-task orphan reaper against a REAL Postgres.
 *
 * A mail migration runs as a promise inside ONE platform-api replica, and HA
 * runs three. A replica booting while another replica's migration is still in
 * flight — a deploy, or during a DR failover the replica the dead node took
 * down — used to mark that live run 'failed', and with it gone from "in
 * flight", the guards keyed on it (placement start-up reconcile, active-node
 * persist) stopped protecting the migration. A run's
 * owner now holds a liveness lease (task-liveness.ts); the reaper only takes
 * runs and tasks whose lease is missing or expired.
 *
 * Needs a database — CI's integration job provides DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { claimSchedulerLease } from '../../shared/scheduler-lease.js';
import { reapMailTaskOrphans } from './orphan-reaper.js';
import { mailTaskLeaseName, MAIL_TASK_LIVENESS_TTL_MS } from './task-liveness.js';

const url = process.env.REAPER_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!url)('mail-task orphan reaper (real Postgres)', () => {
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=orphan_reaper_test' });
    await pool.query('DROP SCHEMA IF EXISTS orphan_reaper_test CASCADE');
    await pool.query('CREATE SCHEMA orphan_reaper_test');
    await pool.query(`CREATE TABLE platform_settings (setting_key varchar(100) PRIMARY KEY, setting_value text NOT NULL,
      updated_at timestamp NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE tasks (id varchar(36) PRIMARY KEY, kind varchar(64) NOT NULL, status varchar(16) NOT NULL,
      error_message text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz)`);
    await pool.query(`CREATE TABLE mail_migration_runs (id varchar(36) PRIMARY KEY, state varchar(64) NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, error_message text)`);
    db = drizzle(pool);
  });

  afterAll(async () => {
    await pool?.query('DROP SCHEMA IF EXISTS orphan_reaper_test CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE platform_settings, tasks, mail_migration_runs');
  });

  const addRun = (id: string, ageSeconds: number, state = 'running') => pool.query(
    `INSERT INTO mail_migration_runs (id, state, started_at) VALUES ($1, $2, now() - make_interval(secs => $3))`,
    [id, state, ageSeconds],
  );
  const addTask = (id: string, ageSeconds: number, kind = 'mail.migration') => pool.query(
    `INSERT INTO tasks (id, kind, status, started_at) VALUES ($1, $2, 'running', now() - make_interval(secs => $3))`,
    [id, kind, ageSeconds],
  );
  const lease = (id: string) => claimSchedulerLease(db, mailTaskLeaseName(id), MAIL_TASK_LIVENESS_TTL_MS, 'replica-a');
  const expire = (id: string) => pool.query(
    `UPDATE platform_settings SET setting_value = jsonb_set(setting_value::jsonb, '{until}', to_jsonb(now() - interval '1 second'))::text
      WHERE setting_key = $1`, [`scheduler-lease:${mailTaskLeaseName(id)}`],
  );
  const runState = async (id: string) =>
    (await pool.query('SELECT state FROM mail_migration_runs WHERE id = $1', [id])).rows[0]?.state as string;
  const taskStatus = async (id: string) =>
    (await pool.query('SELECT status FROM tasks WHERE id = $1', [id])).rows[0]?.status as string;

  it('leaves a run and its task alone while their owner keeps the lease', async () => {
    await addRun('run-live', 300);
    await addTask('task-live', 300);
    await lease('run-live');
    await lease('task-live');
    expect(await reapMailTaskOrphans(db)).toMatchObject({ tasksReaped: 0, runsReaped: 0 });
    expect(await runState('run-live')).toBe('running');
    expect(await taskStatus('task-live')).toBe('running');
  });

  it('reaps a run and task whose owner died (lease expired) — queued runs too', async () => {
    await addRun('run-dead', 300);
    await addRun('run-dead-queued', 300, 'queued');
    await addTask('task-dead', 300, 'mail.port-exposure');
    for (const id of ['run-dead', 'run-dead-queued', 'task-dead']) {
      await lease(id);
      await expire(id);
    }
    expect(await reapMailTaskOrphans(db)).toMatchObject({ tasksReaped: 1, runsReaped: 2 });
    expect(await runState('run-dead')).toBe('failed');
    expect(await runState('run-dead-queued')).toBe('failed');
    expect(await taskStatus('task-dead')).toBe('failed');
  });

  // No lease at all = started by a replica running a release without leases (a
  // rolling upgrade), or one whose claim failed: its owner may well be alive, so
  // it gets a 10-minute grace instead of 60 s.
  it('gives a run that never had a lease 10 minutes before reaping it', async () => {
    await addRun('run-unleased-young', 300);
    await addRun('run-unleased-old', 660);
    await addTask('task-unleased-young', 300);
    expect(await reapMailTaskOrphans(db)).toMatchObject({ tasksReaped: 0, runsReaped: 1 });
    expect(await runState('run-unleased-young')).toBe('running');
    expect(await runState('run-unleased-old')).toBe('failed');
    expect(await taskStatus('task-unleased-young')).toBe('running');
  });

  it('still never reaps work younger than 60 s or already finished', async () => {
    await addRun('run-young', 10);
    await addRun('run-done', 300, 'done');
    expect(await reapMailTaskOrphans(db)).toMatchObject({ runsReaped: 0 });
    expect(await runState('run-young')).toBe('running');
    expect(await runState('run-done')).toBe('done');
  });

  it('drops expired liveness leases but keeps live ones and other jobs', async () => {
    await lease('gone');
    await expire('gone');
    await pool.query(`UPDATE platform_settings SET updated_at = now() - interval '2 days'`);
    await lease('live');
    await claimSchedulerLease(db, 'some-scheduled-job', 60_000, 'replica-a');
    await expire('some-scheduled-job');
    await reapMailTaskOrphans(db);
    const keys = (await pool.query('SELECT setting_key FROM platform_settings ORDER BY 1')).rows.map((r) => r.setting_key);
    expect(keys).toEqual([`scheduler-lease:${mailTaskLeaseName('live')}`, 'scheduler-lease:some-scheduled-job']);
  });
});

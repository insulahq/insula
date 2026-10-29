/**
 * A private worker is an application on the subscription's limit — against a
 * REAL Postgres, because the create now runs inside the slot's transaction
 * (advisory lock + savepoint per insert attempt), which a mocked client
 * agrees with whatever it does.
 *
 * Only the gate's two inputs (platform switch, subscription) are mocked.
 * Runs in the integration suite (DATABASE_URL); tables live in this file's
 * own schema.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';

vi.mock('../system-settings/service.js', () => ({
  getSettings: async () => ({ customDeploymentsEnabled: true }),
}));
vi.mock('../subscriptions/service.js', () => ({
  isCustomContainersAllowedByPlan: async () => true,
}));

const schema = await import('../../db/schema.js');
const { createPrivateWorker, revokePrivateWorker, deletePrivateWorker, rotatePrivateWorker } = await import('./service.js');
const { getApplicationUsage, withApplicationSlot } = await import('../deployments/application-limit.js');
type Database = import('../../db/index.js').Database;

const url = process.env.DATABASE_URL;
const PLAN = 'pppppppp-0000-4000-8000-000000000002';
const TENANT = 'tttttttt-0000-4000-8000-000000000002';

describe.skipIf(!url)('private workers count as applications (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=pw_app_limit_test', max: 6 });
    await pool.query('DROP SCHEMA IF EXISTS pw_app_limit_test CASCADE');
    await pool.query('CREATE SCHEMA pw_app_limit_test');
    await pool.query('CREATE TABLE hosting_plans (id varchar(36) PRIMARY KEY, max_applications integer NOT NULL DEFAULT 20)');
    await pool.query(`CREATE TABLE tenants (id varchar(36) PRIMARY KEY, plan_id varchar(36) NOT NULL,
      max_applications_override integer, private_worker_shared_secret varchar(64),
      updated_at timestamp NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE deployments (id varchar(36) PRIMARY KEY, tenant_id varchar(36) NOT NULL,
      name text NOT NULL, status text NOT NULL)`);
    await pool.query(`CREATE TABLE private_workers (
      id varchar(36) PRIMARY KEY, tenant_id varchar(36) NOT NULL, name varchar(120) NOT NULL,
      slug varchar(60) NOT NULL UNIQUE, worker_token_hash varchar(64) NOT NULL,
      status text NOT NULL DEFAULT 'pending', exposed_port integer NOT NULL, description text,
      last_seen_at timestamp, last_used_ip inet, bytes_in bigint NOT NULL DEFAULT 0,
      bytes_out bigint NOT NULL DEFAULT 0, created_by varchar(36),
      created_at timestamp NOT NULL DEFAULT now(), revoked_at timestamp, revoked_by varchar(36),
      updated_at timestamp NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, name), UNIQUE (tenant_id, exposed_port))`);
    await pool.query(`CREATE TABLE private_worker_audit (id bigserial PRIMARY KEY,
      private_worker_id varchar(36) NOT NULL REFERENCES private_workers(id) ON DELETE CASCADE,
      event varchar(40) NOT NULL, ip inet, detail jsonb, occurred_at timestamp NOT NULL DEFAULT now())`);
    db = drizzle(pool, { schema }) as unknown as Database;
  });

  afterAll(async () => {
    await pool?.query('DROP SCHEMA IF EXISTS pw_app_limit_test CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE hosting_plans, tenants, deployments, private_workers, private_worker_audit');
    await pool.query('INSERT INTO hosting_plans (id, max_applications) VALUES ($1, 2)', [PLAN]);
    await pool.query('INSERT INTO tenants (id, plan_id) VALUES ($1, $2)', [TENANT, PLAN]);
    await pool.query(`INSERT INTO deployments VALUES ('d1', $1, 'site', 'running')`, [TENANT]);
  });

  const workerCount = async () => (await pool.query('SELECT count(*)::int AS n FROM private_workers')).rows[0].n as number;

  it('a worker takes a slot, and the one after it is refused with the worker wording', async () => {
    const first = await createPrivateWorker(db, TENANT, { name: 'home-nas' }, 'u1');
    expect(first.worker.status).toBe('pending');
    expect(first.worker.exposedPort).toBe(10000);
    expect(await getApplicationUsage(db, TENANT)).toEqual({ limit: 2, current: 2, privateWorkers: 1, remaining: 0, source: 'plan' });
    // The audit row is written after the slot's transaction committed the worker.
    expect((await pool.query('SELECT event FROM private_worker_audit')).rows).toEqual([{ event: 'mint' }]);

    await expect(createPrivateWorker(db, TENANT, { name: 'gpu-box' }, 'u1')).rejects.toMatchObject({
      code: 'APPLICATION_LIMIT_REACHED',
      status: 409,
      message: expect.stringMatching(/^Creating another private worker would exceed your subscription's limit of 2 applications: 2 are deployed/),
    });
    expect(await workerCount()).toBe(1);
  });

  it('a full limit of workers also refuses a deploy', async () => {
    await createPrivateWorker(db, TENANT, { name: 'home-nas' }, 'u1');
    await expect(withApplicationSlot(db, TENANT, 'deploy', (tx) =>
      tx.execute(sql`INSERT INTO deployments VALUES ('d2', ${TENANT}, 'blog', 'pending')`)))
      .rejects.toMatchObject({ code: 'APPLICATION_LIMIT_REACHED', message: expect.stringMatching(/^Deploying another application/) });
  });

  it('a revoked worker no longer counts, and a deleted one is gone', async () => {
    const w = await createPrivateWorker(db, TENANT, { name: 'home-nas' }, 'u1');
    await revokePrivateWorker(db, TENANT, w.workerId, 'u1');
    expect(await getApplicationUsage(db, TENANT)).toMatchObject({ current: 1, privateWorkers: 0, remaining: 1 });
    const next = await createPrivateWorker(db, TENANT, { name: 'gpu-box' }, 'u1');
    // Revoked rows keep their port; the new worker gets the next one.
    expect(next.worker.exposedPort).toBe(10001);
    await deletePrivateWorker(db, TENANT, next.workerId, 'u1');
    expect(await getApplicationUsage(db, TENANT)).toMatchObject({ current: 1, privateWorkers: 0 });
  });

  it('★ a worker and a deploy racing for the last slot: exactly one gets it', async () => {
    const deploy = withApplicationSlot(db, TENANT, 'deploy', async (tx) => {
      // Hold the lock long enough that the worker create really waits on it.
      await tx.execute(sql`SELECT pg_sleep(0.3)`);
      return tx.execute(sql`INSERT INTO deployments VALUES ('d2', ${TENANT}, 'blog', 'pending')`);
    });
    const worker = createPrivateWorker(db, TENANT, { name: 'home-nas' }, 'u1');
    const results = await Promise.allSettled([deploy, worker]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)
      .toMatchObject({ code: 'APPLICATION_LIMIT_REACHED' });
    expect((await getApplicationUsage(db, TENANT)).current).toBe(2);
  });

  it('two workers racing for the last slot: exactly one gets it, and no port is shared', async () => {
    const results = await Promise.allSettled([
      createPrivateWorker(db, TENANT, { name: 'a' }, 'u1'),
      createPrivateWorker(db, TENANT, { name: 'b' }, 'u1'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await workerCount()).toBe(1);
  });

  it('★ a unique violation inside the slot is retried — the savepoint keeps the transaction usable', async () => {
    // The first insert attempt fails as a port collision would. A sequence is
    // not rolled back with the savepoint, so only that one attempt fails.
    await pool.query('CREATE SEQUENCE IF NOT EXISTS pw_fail_once');
    await pool.query(`CREATE OR REPLACE FUNCTION pw_fail_first_insert() RETURNS trigger AS $$
      BEGIN
        IF nextval('pw_fail_once') = 1 THEN
          RAISE EXCEPTION 'duplicate key value violates unique constraint' USING ERRCODE = 'unique_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await pool.query('CREATE TRIGGER pw_fail_first BEFORE INSERT ON private_workers FOR EACH ROW EXECUTE FUNCTION pw_fail_first_insert()');
    try {
      const w = await createPrivateWorker(db, TENANT, { name: 'home-nas' }, 'u1');
      expect(w.worker.status).toBe('pending');
      expect(await workerCount()).toBe(1);
      expect((await pool.query("SELECT last_value::int AS n FROM pw_fail_once")).rows[0].n).toBe(2);
    } finally {
      await pool.query('DROP TRIGGER pw_fail_first ON private_workers');
      await pool.query('DROP SEQUENCE pw_fail_once');
    }
  });

  it('rotate changes the token, not the status; a revoked worker is refused and stays revoked', async () => {
    const w = await createPrivateWorker(db, TENANT, { name: 'home-nas' }, 'u1');
    // Never connected: rotating must not make it read "Connected".
    const rotated = await rotatePrivateWorker(db, TENANT, w.workerId, 'u1');
    expect(rotated.worker.status).toBe('pending');
    // Suspended with its tenant: rotating must not undo that.
    await pool.query("UPDATE private_workers SET status = 'suspended'");
    expect((await rotatePrivateWorker(db, TENANT, w.workerId, 'u1')).worker.status).toBe('suspended');
    await pool.query("UPDATE private_workers SET status = 'active'");
    expect((await rotatePrivateWorker(db, TENANT, w.workerId, 'u1')).worker.status).toBe('active');
    await revokePrivateWorker(db, TENANT, w.workerId, 'u1');
    const secretBefore = (await pool.query('SELECT private_worker_shared_secret AS s FROM tenants')).rows[0].s;
    await expect(rotatePrivateWorker(db, TENANT, w.workerId, 'u1')).rejects.toMatchObject({ code: 'PRIVATE_WORKER_REVOKED' });
    expect((await pool.query('SELECT status FROM private_workers')).rows[0].status).toBe('revoked');
    expect((await pool.query('SELECT private_worker_shared_secret AS s FROM tenants')).rows[0].s).toBe(secretBefore);
  });

  it('with room for both, two racing creates both land on distinct ports', async () => {
    await pool.query('UPDATE hosting_plans SET max_applications = 5');
    const [a, b] = await Promise.all([
      createPrivateWorker(db, TENANT, { name: 'a' }, 'u1'),
      createPrivateWorker(db, TENANT, { name: 'b' }, 'u1'),
    ]);
    expect(new Set([a.worker.exposedPort, b.worker.exposedPort])).toEqual(new Set([10000, 10001]));
  });
});

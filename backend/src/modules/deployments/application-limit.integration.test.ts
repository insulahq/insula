/**
 * The application limit against a REAL Postgres: the count, the plan and
 * override resolution, and the per-tenant lock that keeps two deploys from
 * sharing the last slot (a mocked client agrees with any of it).
 *
 * Runs in the integration suite (DATABASE_URL). Tables live in this file's
 * own schema.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { getApplicationUsage, withApplicationSlot } from './application-limit.js';
import { withinApplicationLimitForCart } from '../backup-restore/executors/application-limit-guard.js';
import type { FastifyInstance } from 'fastify';

const url = process.env.DATABASE_URL;
const PLAN = 'pppppppp-0000-4000-8000-000000000001';
const TENANT = 'tttttttt-0000-4000-8000-000000000001';

describe.skipIf(!url)('application limit (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=application_limit_test', max: 6 });
    await pool.query('DROP SCHEMA IF EXISTS application_limit_test CASCADE');
    await pool.query('CREATE SCHEMA application_limit_test');
    await pool.query('CREATE TABLE hosting_plans (id varchar(36) PRIMARY KEY, max_applications integer NOT NULL DEFAULT 20)');
    await pool.query(`CREATE TABLE tenants (id varchar(36) PRIMARY KEY, plan_id varchar(36) NOT NULL,
      max_applications_override integer)`);
    await pool.query(`CREATE TABLE deployments (id varchar(36) PRIMARY KEY, tenant_id varchar(36) NOT NULL,
      name text NOT NULL, status text NOT NULL)`);
    await pool.query('CREATE TABLE restore_jobs (id varchar(64) PRIMARY KEY, tenant_id varchar(36) NOT NULL)');
    db = drizzle(pool, { schema }) as unknown as Database;
  });

  afterAll(async () => {
    await pool?.query('DROP SCHEMA IF EXISTS application_limit_test CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE hosting_plans, tenants, deployments, restore_jobs');
    await pool.query("INSERT INTO restore_jobs (id, tenant_id) VALUES ('job-1', $1)", [TENANT]);
    await pool.query('INSERT INTO hosting_plans (id, max_applications) VALUES ($1, 2)', [PLAN]);
    await pool.query('INSERT INTO tenants (id, plan_id) VALUES ($1, $2)', [TENANT, PLAN]);
  });

  const insertApp = (tx: Database, name: string) =>
    tx.execute(sql`INSERT INTO deployments (id, tenant_id, name, status) VALUES (${`d-${name}`}, ${TENANT}, ${name}, 'pending')`);

  it('counts stopped applications and not deleted ones', async () => {
    await pool.query(`INSERT INTO deployments VALUES ('d1', $1, 'a', 'stopped'), ('d2', $1, 'b', 'deleted'), ('d3', $1, 'c', 'failed')`, [TENANT]);
    expect(await getApplicationUsage(db, TENANT)).toEqual({ limit: 2, current: 2, remaining: 0, source: 'plan' });
  });

  it('★ two deploys racing for the last slot: exactly one gets it', async () => {
    await pool.query(`INSERT INTO deployments VALUES ('d1', $1, 'a', 'running')`, [TENANT]);
    // Hold the lock long enough that the second really waits on it.
    const slow = (name: string) => withApplicationSlot(db, TENANT, 'deploy', async (tx) => {
      await tx.execute(sql`SELECT pg_sleep(0.3)`);
      return insertApp(tx, name);
    });
    const results = await Promise.allSettled([slow('x'), slow('y')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'APPLICATION_LIMIT_REACHED', status: 409 });
    expect((await pool.query('SELECT count(*)::int AS n FROM deployments WHERE status <> $1', ['deleted'])).rows[0].n).toBe(2);
  });

  it('an override wins over the plan, and 0 means none', async () => {
    await pool.query('UPDATE tenants SET max_applications_override = 0');
    await expect(withApplicationSlot(db, TENANT, 'deploy', (tx) => insertApp(tx, 'x')))
      .rejects.toMatchObject({ code: 'APPLICATION_LIMIT_REACHED', message: 'Your subscription does not include applications.' });
    await pool.query('UPDATE tenants SET max_applications_override = 3');
    expect((await getApplicationUsage(db, TENANT)).limit).toBe(3);
  });

  it('a tenant over its limit keeps what it has but cannot add', async () => {
    await pool.query(`INSERT INTO deployments VALUES ('d1', $1, 'a', 'running'), ('d2', $1, 'b', 'running'), ('d3', $1, 'c', 'running')`, [TENANT]);
    expect(await getApplicationUsage(db, TENANT)).toMatchObject({ current: 3, remaining: 0 });
    await expect(withApplicationSlot(db, TENANT, 'restore', (tx) => insertApp(tx, 'x')))
      .rejects.toMatchObject({ code: 'APPLICATION_LIMIT_REACHED' });
    expect((await pool.query('SELECT count(*)::int AS n FROM deployments')).rows[0].n).toBe(3);
  });

  describe('a restore cart that brings applications back', () => {
    const app = () => ({ db }) as unknown as FastifyInstance;
    const bundle = [
      { id: 'd1', status: 'running' },   // live now — not new
      { id: 'd8', status: 'running' },   // gone now — comes back
      { id: 'd9', status: 'stopped' },   // gone now — comes back (stopped counts)
    ];
    beforeEach(async () => {
      await pool.query(`INSERT INTO deployments VALUES ('d1', $1, 'a', 'running')`, [TENANT]);
    });

    it('★ a tenant cart is refused when what it revives does not fit', async () => {
      let wrote = false;
      await expect(withinApplicationLimitForCart({
        app: app(), restoreJobId: 'job-1', tenantCart: true, bundleRows: bundle,
        write: async () => { wrote = true; },
      })).rejects.toMatchObject({ code: 'APPLICATION_LIMIT_REACHED', message: expect.stringMatching(/^Restoring 2 applications/) });
      expect(wrote).toBe(false);
    });

    it('a tenant cart that fits, or revives nothing new, goes through', async () => {
      let wrote = 0;
      await withinApplicationLimitForCart({
        app: app(), restoreJobId: 'job-1', tenantCart: true, bundleRows: bundle.slice(0, 2),
        write: async () => { wrote += 1; },
      });
      await withinApplicationLimitForCart({
        app: app(), restoreJobId: 'job-1', tenantCart: true, bundleRows: [bundle[0]],
        write: async () => { wrote += 1; },
      });
      expect(wrote).toBe(2);
    });

    it('an operator\'s cart is not held to the limit — recovery must bring back what the tenant had', async () => {
      let wrote = false;
      await withinApplicationLimitForCart({
        app: app(), restoreJobId: 'job-1', tenantCart: false, bundleRows: bundle,
        write: async () => { wrote = true; },
      });
      expect(wrote).toBe(true);
    });
  });
});

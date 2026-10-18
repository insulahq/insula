/**
 * The whole reconcile loop through a production outage,
 * against a REAL Postgres (the loop is SQL: RETURNING, conditional claims, a
 * sub-select on storage_operations — a mocked client agrees with all of it).
 *
 * A tenant pinned to a node that was powered off: three workloads down, the
 * first events of the shutdown saying "exceeded quota". What happened: the
 * alert blamed the quota and told the operator to raise plan limits, three
 * pushes and three emails went out, the auto-heal scaled the tenant down and
 * up against a node that was not there and left it storage-state FAILED, and
 * nothing said anything when it came back. What must happen instead is
 * asserted below, tick by tick.
 *
 * Runs in the integration suite (DATABASE_URL) or against a throwaway
 * database (WORKLOAD_HEALTH_TEST_DATABASE_URL). Tables live in this file's own schema.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const sent = vi.hoisted(() => ({ calls: [] as Array<{ fn: string; args: unknown[] }> }));
vi.mock('../notifications/events.js', () => {
  const rec = (fn: string) => async (...args: unknown[]) => { sent.calls.push({ fn, args }); return { ok: true }; };
  return {
    notifyAdminTenantWorkloadsDown: rec('adminDown'),
    notifyTenantWorkloadsDown: rec('tenantDown'),
    notifyAdminTenantWorkloadsRecovered: rec('adminRecovered'),
    notifyTenantWorkloadsRecovered: rec('tenantRecovered'),
  };
});

const { reconcileTenantWorkloadHealth } = await import('./workload-health.js');

const url = process.env.WORKLOAD_HEALTH_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const migration = (name: string) => readFileSync(fileURLToPath(new URL(`../../db/migrations/${name}`, import.meta.url)), 'utf8');
const NS = 'tenant-example-0a1b2c3d';
const TENANT = '11111111-0000-4000-8000-000000000001';

describe.skipIf(!url)('workload-health — a tenant whose pinned node is powered off (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Database;
  let sv1Ready = false;
  let available = 0;

  const k8s = {
    apps: {
      listDeploymentForAllNamespaces: async () => ({
        items: ['moodle', 'my-mariadb', 'website'].map((name) => ({
          metadata: { name, namespace: NS, annotations: {} },
          spec: { replicas: 1 },
          status: { availableReplicas: available },
        })),
      }),
    },
    core: {
      listNode: async () => ({
        items: [
          { metadata: { name: 's1' }, status: { conditions: [{ type: 'Ready', status: sv1Ready ? 'True' : 'False' }] } },
          { metadata: { name: 's3' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
        ],
      }),
      listNamespacedPod: async () => ({ items: [] }),
      // The first seconds of the shutdown, verbatim shape: the old pods still
      // count against the quota, so every replacement is refused.
      listNamespacedEvent: async () => ({
        items: [{
          reason: 'FailedCreate', lastTimestamp: new Date().toISOString(),
          message: `Error creating: pods "website-x" is forbidden: exceeded quota: ${NS}-quota, requested: limits.memory=32Mi`,
        }],
      }),
    },
  } as unknown as K8sClients;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=workload_health_outage_test' });
    await pool.query('DROP SCHEMA IF EXISTS workload_health_outage_test CASCADE');
    await pool.query('CREATE SCHEMA workload_health_outage_test');
    await pool.query(`CREATE TABLE tenants (
      id varchar(36) PRIMARY KEY, name text NOT NULL, kubernetes_namespace text, status text NOT NULL,
      storage_lifecycle_state text NOT NULL DEFAULT 'idle', active_storage_op_id varchar(36), node_name text)`);
    await pool.query(`CREATE TABLE storage_operations (
      id varchar(36) PRIMARY KEY, tenant_id varchar(36) NOT NULL, op_type text NOT NULL, state text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(migration('0135_tenant_workload_health_episodes.sql'));
    await pool.query(migration('0141_tenant_placement.sql'));
    db = drizzle(pool, { schema }) as unknown as Database;
  });

  afterAll(async () => {
    await pool?.query('DROP SCHEMA IF EXISTS workload_health_outage_test CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    sent.calls.length = 0;
    sv1Ready = false;
    available = 0;
    await pool.query('TRUNCATE tenant_workload_health_events, tenant_storage_failovers, tenants, storage_operations CASCADE');
    await pool.query(
      `INSERT INTO tenants (id, name, kubernetes_namespace, status, node_name) VALUES ($1, 'Example Tenant', $2, 'active', 's1')`,
      [TENANT, NS],
    );
  });

  const reasons = async () => (await pool.query(
    'SELECT workload, reason, heal_attempts FROM tenant_workload_health_events ORDER BY workload',
  )).rows;

  it('records node_down, sends ONE alert listing the workloads, never heals, then says it is back and clears a stale FAILED', async () => {
    // Tick 1 — down, inside the grace window: recorded as the node, not the quota.
    await reconcileTenantWorkloadHealth(db, k8s);
    expect(await reasons()).toEqual([
      { workload: 'moodle', reason: 'node_down', heal_attempts: 0 },
      { workload: 'my-mariadb', reason: 'node_down', heal_attempts: 0 },
      { workload: 'website', reason: 'node_down', heal_attempts: 0 },
    ]);
    expect(sent.calls).toEqual([]);

    // Tick 2 — past the grace window: one admin alert, one tenant copy, no heal.
    await pool.query(`UPDATE tenant_workload_health_events SET first_seen_at = now() - interval '9 minutes'`);
    await reconcileTenantWorkloadHealth(db, k8s);
    // A heal claims an attempt before it scales anything: none was claimed.
    expect((await reasons()).map((r) => r.heal_attempts)).toEqual([0, 0, 0]);
    expect(sent.calls.map((c) => c.fn)).toEqual(['adminDown', 'tenantDown']);
    const admin = sent.calls[0].args[1] as Record<string, unknown>;
    expect(admin).toMatchObject({
      tenantName: 'Tenants pinned to s1',
      workloads: ['Example Tenant: moodle, my-mariadb, website'],
      reason: 'node_down',
      healSummary: expect.stringMatching(/not attempted/),
    });
    expect(String(admin.recommendedAction)).not.toMatch(/plan limits/);
    expect(sent.calls[1].args[2]).toMatchObject({ workloads: ['moodle', 'my-mariadb', 'website'] });

    // Tick 3 — nothing new to say: the ladder holds the next alert back.
    sent.calls.length = 0;
    await reconcileTenantWorkloadHealth(db, k8s);
    expect(sent.calls).toEqual([]);

    // Meanwhile the OLD code's failed auto-heal had left the tenant FAILED.
    await pool.query(`INSERT INTO storage_operations (id, tenant_id, op_type, state) VALUES ('op-1', $1, 'autoheal', 'failed')`, [TENANT]);
    await pool.query(`UPDATE tenants SET storage_lifecycle_state = 'failed'`);

    // Tick 4 — the node is back and the workloads run: "running again", FAILED cleared.
    sv1Ready = true;
    available = 1;
    await reconcileTenantWorkloadHealth(db, k8s);
    expect(sent.calls.map((c) => c.fn)).toEqual(['adminRecovered', 'tenantRecovered']);
    expect(sent.calls[0].args[1]).toMatchObject({
      tenantName: 'Tenants pinned to s1',
      workloads: ['Example Tenant: moodle, my-mariadb, website'],
    });
    expect((await pool.query('SELECT storage_lifecycle_state FROM tenants')).rows[0].storage_lifecycle_state).toBe('idle');
    expect((await pool.query('SELECT count(*)::int AS n FROM tenant_workload_health_events WHERE cleared_at IS NULL')).rows[0].n).toBe(0);
  });

  it('a FAILED left by a resize is NOT cleared — that one needs the operator', async () => {
    sv1Ready = true;
    available = 1;
    await pool.query(`INSERT INTO storage_operations (id, tenant_id, op_type, state) VALUES ('op-2', $1, 'resize', 'failed')`, [TENANT]);
    await pool.query(`UPDATE tenants SET storage_lifecycle_state = 'failed'`);
    await reconcileTenantWorkloadHealth(db, k8s);
    expect((await pool.query('SELECT storage_lifecycle_state FROM tenants')).rows[0].storage_lifecycle_state).toBe('failed');
  });

  it('an outage that never alerted ends silently', async () => {
    await reconcileTenantWorkloadHealth(db, k8s);
    sv1Ready = true;
    available = 1;
    await reconcileTenantWorkloadHealth(db, k8s);
    expect(sent.calls).toEqual([]);
  });
});

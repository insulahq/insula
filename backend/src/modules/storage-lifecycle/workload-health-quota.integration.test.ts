/**
 * The auto-heal against a FULL quota, and its namespace-wide budget — against
 * a REAL Postgres (the claim is a conditional UPDATE with a NOT EXISTS over
 * the same table; a mocked client agrees with anything).
 *
 * Production: a tenant at 530m of a 530m CPU request quota added a 25m pod.
 * The heal (quota refusal = "a terminating pod will free it") scaled all
 * eight workloads to zero and back; the new pod was admitted first and the
 * tenant's established site (30m) was left out. A second heal, claimed by the
 * site's own episode 3.5 minutes later, did the same. What must happen: no
 * restart for a full quota, an alert that names the resource and the figures,
 * and one restart budget per namespace.
 *
 * Runs in the integration suite (DATABASE_URL). Tables live in this file's own schema.
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

const url = process.env.DATABASE_URL;
const migration = (name: string) => readFileSync(fileURLToPath(new URL(`../../db/migrations/${name}`, import.meta.url)), 'utf8');
const NS = 'tenant-example-0a1b2c3d';
const TENANT = '22222222-0000-4000-8000-000000000001';
const REFUSAL = `pods "site-7fc475c7cd-c4w8b" is forbidden: exceeded quota: ${NS}-quota, `
  + 'requested: requests.cpu=30m, used: requests.cpu=525m, limited: requests.cpu=530m';

describe.skipIf(!url)('workload-health — a quota refusal (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Database;
  let quotaUsed = '525m';
  let terminating: unknown[] = [];
  let siteFailure: string | null = `FailedCreate: ${REFUSAL}`;
  let quotaReads = 0;

  const k8s = {
    apps: {
      listDeploymentForAllNamespaces: async () => ({
        items: [
          {
            metadata: { name: 'site', namespace: NS, annotations: {} },
            spec: { replicas: 1 },
            status: {
              availableReplicas: 0,
              conditions: siteFailure ? [{ type: 'ReplicaFailure', status: 'True', reason: 'FailedCreate', message: REFUSAL }] : [],
            },
          },
          { metadata: { name: 'blog', namespace: NS, annotations: {} }, spec: { replicas: 1 }, status: { availableReplicas: 1 } },
        ],
      }),
    },
    core: {
      listNode: async () => ({ items: [{ metadata: { name: 's1' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }] }),
      listNamespacedPod: async () => ({ items: terminating }),
      listNamespacedEvent: async () => ({ items: [] }),
      listNamespacedResourceQuota: async () => {
        quotaReads += 1;
        return {
          items: [{
            metadata: { name: `${NS}-quota` },
            spec: {
              hard: { 'requests.cpu': '530m' },
              scopeSelector: { matchExpressions: [{ scopeName: 'PriorityClass', operator: 'In', values: ['tenant-default'] }] },
            },
            status: { hard: { 'requests.cpu': '530m' }, used: { 'requests.cpu': quotaUsed } },
          }],
        };
      },
    },
  } as unknown as K8sClients;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=workload_health_quota_test' });
    await pool.query('DROP SCHEMA IF EXISTS workload_health_quota_test CASCADE');
    await pool.query('CREATE SCHEMA workload_health_quota_test');
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
    await pool?.query('DROP SCHEMA IF EXISTS workload_health_quota_test CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    sent.calls.length = 0;
    quotaUsed = '525m';
    terminating = [];
    siteFailure = `FailedCreate: ${REFUSAL}`;
    quotaReads = 0;
    await pool.query('TRUNCATE tenant_workload_health_events, tenant_storage_failovers, tenants, storage_operations CASCADE');
    await pool.query(
      `INSERT INTO tenants (id, name, kubernetes_namespace, status, node_name) VALUES ($1, 'Example Tenant', $2, 'active', 's1')`,
      [TENANT, NS],
    );
  });

  const episode = async () => (await pool.query(
    "SELECT reason, heal_attempts FROM tenant_workload_health_events WHERE workload = 'site'",
  )).rows[0];

  it('★ a full quota is never restarted for — the alert names the CPU figures instead', async () => {
    await reconcileTenantWorkloadHealth(db, k8s);
    expect(await episode()).toEqual({ reason: 'quota_rejected', heal_attempts: 0 });

    await pool.query(`UPDATE tenant_workload_health_events SET first_seen_at = now() - interval '9 minutes'`);
    await reconcileTenantWorkloadHealth(db, k8s);
    // No heal claimed: nothing was scaled.
    expect((await episode()).heal_attempts).toBe(0);
    expect(quotaReads).toBe(1);
    expect(sent.calls.map((c) => c.fn)).toEqual(['adminDown', 'tenantDown']);
    const admin = sent.calls[0].args[1] as Record<string, unknown>;
    expect(admin.recommendedAction).toMatch(/quota is full \(requests\.cpu: 525m of 530m in use, 30m more needed\)/);
    expect(admin.recommendedAction).not.toMatch(/free memory/);
  });

  it('a refusal that a terminating pod explains is still worth one restart', async () => {
    quotaUsed = '530m';
    terminating = [{
      metadata: { deletionTimestamp: new Date().toISOString() },
      spec: { priorityClassName: 'tenant-default', containers: [{ resources: { requests: { cpu: '30m' } } }] },
    }];
    await reconcileTenantWorkloadHealth(db, k8s);
    await pool.query(`UPDATE tenant_workload_health_events SET first_seen_at = now() - interval '9 minutes'`);
    await reconcileTenantWorkloadHealth(db, k8s);
    // Claimed — the heal ran (and failed against this minimal fixture, which is
    // not what this asserts).
    expect((await episode()).heal_attempts).toBe(1);
  });

  it('★ the restart budget is the namespace\'s: a neighbour healed minutes ago blocks the next one', async () => {
    siteFailure = null; // site down with no diagnosis → 'unknown', healable
    await pool.query(
      `INSERT INTO tenant_workload_health_events
         (tenant_id, workload, namespace, desired_replicas, available_replicas, reason, first_seen_at,
          heal_attempts, last_heal_at, cleared_at)
       VALUES ($1, 'worker', $2, 1, 1, 'quota_rejected', now() - interval '20 minutes',
               1, now() - interval '3 minutes', now() - interval '1 minute')`,
      [TENANT, NS],
    );
    await reconcileTenantWorkloadHealth(db, k8s);
    await pool.query(`UPDATE tenant_workload_health_events SET first_seen_at = now() - interval '9 minutes' WHERE workload = 'site'`);
    await reconcileTenantWorkloadHealth(db, k8s);
    // Production: this episode claimed its own first attempt 3.5 minutes after
    // the neighbour's and restarted the whole tenant again.
    expect((await episode()).heal_attempts).toBe(0);
  });
});

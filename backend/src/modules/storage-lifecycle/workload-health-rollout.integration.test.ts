/**
 * An app upgrade is not an outage — the whole reconcile loop, against a REAL
 * Postgres, replaying lab DEV (a Moodle 5.0 → 5.3 test, tenant since deleted):
 *
 *   13:49 created; first start (image pull + install) > 1 min → episode, cleared ~13:54
 *   14:03 version change → Recreate → available 0 → the episode reopened with
 *         its 13:50 clock, "down 13 min" → re-staged, database included, 16 s
 *         after the Upgrade click (heal 1/3); later the same again (heal 2/3).
 *
 * What must happen instead, tick by tick: a rollout within its deadline is not
 * judged; one that stalls with pods created after the old episode cleared is a
 * NEW episode with its own grace window; a pod that runs but is not ready is
 * `not_ready`, alerted, never re-staged.
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
const NS = 'tenant-moodle-e2e-0a1b2c3d';
const TENANT = '22222222-0000-4000-8000-000000000002';

describe.skipIf(!url)('workload-health — an app upgrade on a tenant with a recent episode (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Database;
  // The moodle Deployment, as the tick finds it.
  let available = 0;
  let generation = 2;
  let observed = 2;
  let progressing: { status: string; reason: string } | null = null;
  let podCreated = new Date();
  let podReady = false;
  let podPending = false;
  const scaled: string[] = [];

  const k8s = {
    apps: {
      listDeploymentForAllNamespaces: async () => ({
        items: [
          {
            metadata: { name: 'moodle', namespace: NS, annotations: {}, generation },
            spec: { replicas: 1 },
            status: {
              availableReplicas: available, observedGeneration: observed,
              conditions: progressing ? [{ type: 'Progressing', ...progressing, lastUpdateTime: new Date().toISOString() }] : [],
            },
          },
          {
            metadata: { name: 'moodledb', namespace: NS, annotations: {}, generation: 1 },
            spec: { replicas: 1 },
            status: { availableReplicas: 1, observedGeneration: 1, conditions: [] },
          },
        ],
      }),
      // A heal scales the namespace: none may happen in this file.
      patchNamespacedDeploymentScale: async (a: { name: string }) => { scaled.push(a.name); return {}; },
      replaceNamespacedDeploymentScale: async (a: { name: string }) => { scaled.push(a.name); return {}; },
    },
    core: {
      listNode: async () => ({ items: [{ metadata: { name: 's1' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }] }),
      listNamespacedPod: async () => ({
        items: [{
          metadata: {
            name: 'moodle-7c9d8-abcde', uid: 'p1', creationTimestamp: podCreated.toISOString(),
            ownerReferences: [{ kind: 'ReplicaSet', name: 'moodle-7c9d8' }],
          },
          status: podPending
            ? { phase: 'Pending', containerStatuses: [{ ready: false, state: { waiting: { reason: 'ContainerCreating' } } }] }
            : {
                phase: 'Running',
                conditions: [{ type: 'Ready', status: podReady ? 'True' : 'False' }],
                containerStatuses: [{ ready: podReady, restartCount: 0, state: { running: { startedAt: podCreated.toISOString() } } }],
              },
        }],
      }),
      // Verbatim shape of the stale-staging-directory failure (see workload-health.test.ts).
      listNamespacedEvent: async () => ({
        items: podPending ? [{
          type: 'Warning', reason: 'FailedMount', involvedObject: { kind: 'Pod', uid: 'p1', name: 'moodle-7c9d8-abcde' },
          lastTimestamp: new Date().toISOString(),
          message: 'MountVolume.MountDevice failed for volume "pvc-1" : rpc error: code = Internal desc = mkdir /var/lib/kubelet/plugins/kubernetes.io/csi/driver.longhorn.io/abc/globalmount: file exists',
        }] : [],
      }),
    },
  } as unknown as K8sClients;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=workload_health_rollout_test' });
    await pool.query('DROP SCHEMA IF EXISTS workload_health_rollout_test CASCADE');
    await pool.query('CREATE SCHEMA workload_health_rollout_test');
    await pool.query(`CREATE TABLE tenants (
      id varchar(36) PRIMARY KEY, name text NOT NULL, kubernetes_namespace text, status text NOT NULL,
      storage_lifecycle_state text NOT NULL DEFAULT 'idle', active_storage_op_id varchar(36), node_name text)`);
    await pool.query(`CREATE TABLE storage_operations (
      id varchar(36) PRIMARY KEY, tenant_id varchar(36) NOT NULL, op_type text NOT NULL, state text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(migration('0135_tenant_workload_health_episodes.sql'));
    await pool.query(migration('0141_tenant_placement.sql'));
    await pool.query(migration('0186_tenant_placement_spare_copies.sql'));
    db = drizzle(pool, { schema }) as unknown as Database;
  });

  afterAll(async () => {
    await pool?.query('DROP SCHEMA IF EXISTS workload_health_rollout_test CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    sent.calls.length = 0;
    scaled.length = 0;
    available = 0; generation = 2; observed = 2; progressing = null; podReady = false; podPending = false; podCreated = new Date();
    await pool.query('TRUNCATE tenant_workload_health_events, tenant_storage_failovers, tenants, storage_operations CASCADE');
    await pool.query(
      `INSERT INTO tenants (id, name, kubernetes_namespace, status, node_name) VALUES ($1, 'Moodle E2E', $2, 'active', 's1')`,
      [TENANT, NS],
    );
  });

  const episode = async () => (await pool.query(
    `SELECT reason, heal_attempts, cleared_at, EXTRACT(EPOCH FROM now() - first_seen_at)::int AS age
       FROM tenant_workload_health_events WHERE workload = 'moodle'`,
  )).rows[0] as { reason: string; heal_attempts: number; cleared_at: Date | null; age: number } | undefined;

  it('a first start still installing is a rollout: no episode at all', async () => {
    generation = 1; observed = 1; progressing = { status: 'True', reason: 'NewReplicaSetCreated' };
    await reconcileTenantWorkloadHealth(db, k8s);
    expect(await episode()).toBeUndefined();
  });

  it('the upgrade after a recent episode: not judged while it rolls, a NEW episode once it stalls, alerted and never re-staged', async () => {
    // The first-start episode: began 50 min ago, healed once, cleared 10 min ago.
    await pool.query(
      `INSERT INTO tenant_workload_health_events
         (tenant_id, workload, namespace, desired_replicas, reason, first_seen_at, cleared_at, heal_attempts, last_heal_at)
       VALUES ($1, 'moodle', $2, 1, 'unknown', now() - interval '50 minutes', now() - interval '10 minutes', 1, now() - interval '40 minutes')`,
      [TENANT, NS],
    );

    // Tick 1 — the Upgrade click: a new spec, the pod replaced (Recreate), not available.
    generation = 3; observed = 2; progressing = { status: 'True', reason: 'NewReplicaSetAvailable' };
    podCreated = new Date(Date.now() - 5_000);
    await reconcileTenantWorkloadHealth(db, k8s);
    expect(await episode()).toMatchObject({ heal_attempts: 1, cleared_at: expect.any(Date) });

    // Tick 2 — the controller is rolling it out.
    observed = 3; progressing = { status: 'True', reason: 'ReplicaSetUpdated' };
    await reconcileTenantWorkloadHealth(db, k8s);
    expect((await episode())?.cleared_at).not.toBeNull();

    // Tick 3 — the migration outlasts the progress deadline: the pod runs, not ready.
    progressing = { status: 'False', reason: 'ProgressDeadlineExceeded' };
    await reconcileTenantWorkloadHealth(db, k8s);
    const reopened = await episode();
    expect(reopened).toMatchObject({ reason: 'not_ready', heal_attempts: 1, cleared_at: null });
    expect(reopened!.age).toBeLessThan(60);
    expect(sent.calls).toEqual([]);

    // Tick 4 — past its own grace window: alerted, never re-staged.
    await pool.query(`UPDATE tenant_workload_health_events SET first_seen_at = now() - interval '9 minutes' WHERE workload = 'moodle'`);
    await reconcileTenantWorkloadHealth(db, k8s);
    expect((await episode())?.heal_attempts).toBe(1);
    expect(scaled).toEqual([]);
    expect(sent.calls.map((c) => c.fn)).toEqual(['adminDown', 'tenantDown']);
    expect(sent.calls[0].args[1]).toMatchObject({ reason: 'not_ready' });

    // Tick 5 — the migration finishes: running again.
    available = 1; podReady = true; progressing = { status: 'True', reason: 'NewReplicaSetAvailable' };
    sent.calls.length = 0;
    await reconcileTenantWorkloadHealth(db, k8s);
    expect((await episode())?.cleared_at).not.toBeNull();
    expect(sent.calls.map((c) => c.fn)).toEqual(['adminRecovered', 'tenantRecovered']);
  });

  it('an episode already open when the rollout starts restarts its clock: the rollout ending is followed by a full grace window', async () => {
    await pool.query(
      `INSERT INTO tenant_workload_health_events (tenant_id, workload, namespace, desired_replicas, reason, first_seen_at)
       VALUES ($1, 'moodle', $2, 1, 'unknown', now() - interval '60 minutes')`,
      [TENANT, NS],
    );
    generation = 3; observed = 3; progressing = { status: 'True', reason: 'ReplicaSetUpdated' };
    await reconcileTenantWorkloadHealth(db, k8s);
    expect((await episode())!.age).toBeLessThan(60);
    progressing = { status: 'False', reason: 'ProgressDeadlineExceeded' };
    await reconcileTenantWorkloadHealth(db, k8s);
    expect((await episode())!.age).toBeLessThan(120);
    expect(scaled).toEqual([]);
  });

  it('a volume that will not mount is judged during a rollout as at any other time', async () => {
    generation = 3; observed = 3; progressing = { status: 'True', reason: 'ReplicaSetUpdated' };
    podPending = true;
    await reconcileTenantWorkloadHealth(db, k8s);
    expect(await episode()).toMatchObject({ reason: 'volume_attach' });
  });
});

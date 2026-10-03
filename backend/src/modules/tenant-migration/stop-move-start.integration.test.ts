/**
 * A running tenant's move against a REAL Postgres and a fake cluster: the claim
 * that keeps two operations off one volume, the whole stop → detach → re-pin →
 * start sequence, and quiesce-watchdog recovering a move whose process died.
 *
 * Needs a database — CI's integration job provides DATABASE_URL; locally, point
 * it (or MOVE_TEST_DATABASE_URL) at a throwaway Postgres. Every table lives in
 * this file's own schema.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/** The fake cluster: one tenant namespace, its Deployments and its Longhorn volume. */
const cluster = vi.hoisted(() => ({
  log: [] as string[],
  deployments: [] as Array<{ name: string; replicas: number; node: string | null }>,
}));

vi.mock('../../shared/scale-deployment.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/scale-deployment.js')>()),
  scaleDeploymentReplicas: vi.fn(async (_ns: string, name: string, replicas: number) => {
    const d = cluster.deployments.find((x) => x.name === name);
    if (d) d.replicas = replicas;
    cluster.log.push(`scale:${name}:${replicas}${replicas > 0 ? `@${d?.node ?? '?'}` : ''}`);
  }),
}));

const { beginTenantMove } = await import('./stop-move-start.js');
const { sweepAbandonedQuiesce } = await import('../storage-lifecycle/quiesce-watchdog.js');

const url = process.env.MOVE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const RELOCATE_MIGRATION = fileURLToPath(new URL('../../db/migrations/0144_storage_op_relocate.sql', import.meta.url));
const NS = 'tenant-acme';

function fakeK8s(): K8sClients {
  const deploymentView = (d: { name: string; replicas: number; node: string | null }) => ({
    metadata: { name: d.name, annotations: {} },
    spec: { replicas: d.replicas, template: { spec: d.node ? { nodeSelector: { 'kubernetes.io/hostname': d.node } } : {} } },
    status: { availableReplicas: d.replicas },
  });
  const lh: Record<string, unknown[]> = {
    volumes: [{ metadata: { name: 'pvc-1' }, spec: { numberOfReplicas: 1 }, status: { state: 'detached', kubernetesStatus: { namespace: NS } } }],
    replicas: [{ spec: { volumeName: 'pvc-1', nodeID: 'node-b' }, status: { currentState: 'stopped' } }],
    volumeattachments: [{ metadata: { name: 'pvc-1' }, spec: { attachmentTickets: {} } }],
  };
  return {
    core: {
      listNamespacedPod: async () => ({ items: [] }),
      readNamespacedPersistentVolumeClaim: async () => ({ spec: { volumeName: 'pvc-1' } }),
    },
    apps: {
      listNamespacedDeployment: async () => ({ items: cluster.deployments.map(deploymentView) }),
      readNamespacedDeployment: async ({ name }: { name: string }) =>
        deploymentView(cluster.deployments.find((d) => d.name === name) ?? { name, replicas: 0, node: null }),
      listDeploymentForAllNamespaces: async () => ({ items: [] }),
      patchNamespacedDeployment: async ({ name, body }: { name: string; body: { spec?: { template?: { spec?: { nodeSelector?: Record<string, string> } } } } }) => {
        const node = body.spec?.template?.spec?.nodeSelector?.['kubernetes.io/hostname'];
        if (node) {
          const d = cluster.deployments.find((x) => x.name === name);
          if (d) d.node = node;
          cluster.log.push(`pin:${name}:${node}`);
        }
        return {};
      },
    },
    batch: {
      listNamespacedCronJob: async () => ({ items: [] }),
      listNamespacedJob: async () => ({ items: [] }),
    },
    custom: {
      getNamespacedCustomObject: async () => { cluster.log.push('detach-check'); return { status: { state: 'detached' } }; },
      listNamespacedCustomObject: async ({ plural }: { plural: string }) => ({ items: lh[plural] ?? [] }),
      patchNamespacedCustomObject: async ({ body }: { body: { spec?: { attachmentTickets?: Record<string, { nodeID?: string } | null> } } }) => {
        const ticket = body.spec?.attachmentTickets?.['insula-relocate'];
        if (ticket) cluster.log.push(`ticket:${ticket.nodeID}`);
        return {};
      },
    },
  } as unknown as K8sClients;
}

describe.skipIf(!url)('moving a running tenant (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=tenant_move_test' });
    await pool.query('DROP SCHEMA IF EXISTS tenant_move_test CASCADE');
    await pool.query('CREATE SCHEMA tenant_move_test');
    // The op type as it was before 0144, then 0144 itself: the migration must
    // add the label, and inserting a 'relocate' op must work afterwards.
    await pool.query(`CREATE TYPE storage_operation_type AS ENUM
      ('snapshot', 'resize', 'suspend', 'resume', 'archive', 'restore', 'fsck', 'autoheal')`);
    await pool.query(readFileSync(RELOCATE_MIGRATION, 'utf8'));
    await pool.query(`CREATE TABLE tenants (id varchar(36) PRIMARY KEY, kubernetes_namespace varchar(63),
      node_name varchar(255), storage_tier varchar(16), status varchar(32) NOT NULL DEFAULT 'active',
      storage_lifecycle_state varchar(32) NOT NULL DEFAULT 'idle', active_storage_op_id varchar(36),
      updated_at timestamp NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE storage_operations (id varchar(36) PRIMARY KEY, tenant_id varchar(36) NOT NULL,
      op_type storage_operation_type NOT NULL, state varchar(32) NOT NULL DEFAULT 'idle',
      progress_pct integer NOT NULL DEFAULT 0, progress_message text, params jsonb, progress_steps jsonb,
      snapshot_id varchar(36), rolled_back integer NOT NULL DEFAULT 0, last_error text,
      triggered_by_user_id varchar(36), bytes_transferred numeric(20,0) NOT NULL DEFAULT 0,
      created_at timestamp NOT NULL DEFAULT now(), completed_at timestamp)`);
    db = drizzle(pool, { schema }) as unknown as Database;
  });

  afterAll(async () => {
    await pool?.query('DROP SCHEMA IF EXISTS tenant_move_test CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE tenants, storage_operations');
    await pool.query(`INSERT INTO tenants (id, kubernetes_namespace, node_name, storage_tier) VALUES ('acme', '${NS}', 'node-a', 'local')`);
    cluster.log.length = 0;
    cluster.deployments.splice(0, cluster.deployments.length,
      { name: 'web', replicas: 1, node: null },
      { name: 'db', replicas: 1, node: null },
      { name: 'file-manager', replicas: 0, node: 'node-b' });
  });

  const input = { tenantId: 'acme', namespace: NS, storageTier: 'local', sourceNodes: ['node-b'], target: 'node-a', triggeredByUserId: null };

  async function settled(opId: string): Promise<{ state: string; last_error: string | null; progress_message: string | null; params: Record<string, unknown> | null }> {
    for (let i = 0; i < 100; i++) {
      const { rows } = await pool.query('SELECT state, last_error, progress_message, params FROM storage_operations WHERE id = $1', [opId]);
      if (rows[0] && (rows[0].state === 'idle' || rows[0].state === 'failed')) return rows[0];
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`move ${opId} never finished`);
  }

  it('stops everything, waits for the detach, re-pins, starts the copy, and only then starts the tenant', async () => {
    const opId = await beginTenantMove(db, fakeK8s(), input);
    const op = await settled(opId);
    expect(op.state).toBe('idle');
    expect(op.progress_message).toContain('Running on node-a');

    const log = cluster.log;
    const lastStop = Math.max(log.indexOf('scale:web:0'), log.indexOf('scale:db:0'));
    const detached = log.indexOf('detach-check');
    const firstPin = log.findIndex((l) => l.startsWith('pin:'));
    const ticket = log.indexOf('ticket:node-a');
    const firstStart = log.findIndex((l) => /^scale:\w+:1/.test(l));
    expect(lastStop).toBeGreaterThanOrEqual(0);
    expect(lastStop).toBeLessThan(detached);
    expect(detached).toBeLessThan(firstPin);
    expect(firstPin).toBeLessThan(ticket);
    expect(ticket).toBeLessThan(firstStart);
    // Every workload starts on the target — none is left behind on the source.
    expect(log.filter((l) => /^scale:\w+:1/.test(l)).sort()).toEqual(['scale:db:1@node-a', 'scale:web:1@node-a']);
    expect(cluster.deployments.map((d) => d.node)).toEqual(['node-a', 'node-a', 'node-a']);
    expect(op.params).toMatchObject({ targetNode: 'node-a', dataRelocation: { started: ['pvc-1'] } });

    const { rows } = await pool.query('SELECT node_name, storage_lifecycle_state, active_storage_op_id FROM tenants');
    expect(rows[0]).toEqual({ node_name: 'node-a', storage_lifecycle_state: 'idle', active_storage_op_id: null });
  });

  it('refuses while another storage operation owns the tenant, and leaves no operation behind', async () => {
    await pool.query(`UPDATE tenants SET storage_lifecycle_state = 'resizing', active_storage_op_id = 'other-op'`);
    await expect(beginTenantMove(db, fakeK8s(), input)).rejects.toMatchObject({ code: 'STORAGE_OP_IN_PROGRESS', status: 409 });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM storage_operations');
    expect(rows[0].n).toBe(0);
    expect(cluster.log).toEqual([]);
  });

  it('lets exactly one of two simultaneous moves start', async () => {
    const results = await Promise.allSettled([beginTenantMove(db, fakeK8s(), input), beginTenantMove(db, fakeK8s(), input)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const winner = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<string>;
    await settled(winner.value);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM storage_operations');
    expect(rows[0].n).toBe(1);
  });

  describe('quiesce-watchdog and an abandoned move', () => {
    const snapshot = { deployments: [{ name: 'web', replicas: 1 }, { name: 'db', replicas: 1 }], cronJobs: [] };
    async function abandonedMove(minutesAgo: number, opType = 'relocate'): Promise<void> {
      await pool.query(`INSERT INTO storage_operations (id, tenant_id, op_type, state, params, created_at)
        VALUES ('op-1', 'acme', $1, 'quiescing', $2, now() - make_interval(mins => $3))`,
      [opType, JSON.stringify({ targetNode: 'node-c', sourceNodes: ['node-b'], quiesceSnapshot: snapshot }), minutesAgo]);
      await pool.query(`UPDATE tenants SET storage_lifecycle_state = 'quiescing', active_storage_op_id = 'op-1'`);
    }

    it('recovers a move after 30 minutes: pins every workload to the target before starting it', async () => {
      // The process died mid re-pin: web already on the target, db still on the source.
      cluster.deployments.splice(0, cluster.deployments.length,
        { name: 'web', replicas: 0, node: 'node-c' }, { name: 'db', replicas: 0, node: 'node-b' });
      await abandonedMove(31);
      const r = await sweepAbandonedQuiesce(db, fakeK8s());
      expect(r.abandonedOps).toBe(1);
      expect(cluster.deployments.map((d) => d.node)).toEqual(['node-c', 'node-c']);
      expect(cluster.log.filter((l) => l.startsWith('scale:')).sort()).toEqual(['scale:db:1@node-c', 'scale:web:1@node-c']);
      const op = await pool.query('SELECT state FROM storage_operations');
      expect(op.rows[0].state).toBe('failed');
      const t = await pool.query('SELECT node_name, active_storage_op_id FROM tenants');
      expect(t.rows[0]).toEqual({ node_name: 'node-c', active_storage_op_id: null });
    });

    it('never re-pins a workload that is still running — the move had not stopped it yet', async () => {
      cluster.deployments.splice(0, cluster.deployments.length,
        { name: 'web', replicas: 1, node: 'node-b' }, { name: 'db', replicas: 0, node: 'node-b' });
      await abandonedMove(31);
      await sweepAbandonedQuiesce(db, fakeK8s());
      expect(cluster.log.some((l) => l.startsWith('pin:'))).toBe(false);
      expect(cluster.deployments.map((d) => d.node)).toEqual(['node-b', 'node-b']);
    });

    it('leaves a move younger than 30 minutes alone', async () => {
      await abandonedMove(10);
      expect((await sweepAbandonedQuiesce(db, fakeK8s())).abandonedOps).toBe(0);
    });

    it('keeps the 6-hour window for every other operation', async () => {
      await abandonedMove(31, 'resize');
      expect((await sweepAbandonedQuiesce(db, fakeK8s())).abandonedOps).toBe(0);
    });
  });
});

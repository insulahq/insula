/**
 * The placement reconciler tick end to end against a REAL Postgres, replaying
 * a production incident: a storage stall on node-a made Longhorn
 * salvage two tenant volumes at 05:09:29, their pods came back on node-b and data
 * locality moved the data after them.
 *
 * Needs a database — see store.integration.test.ts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { CollectedFacts } from '../tenant-health/collect.js';
import type { PodFact, ReplicaFact, TenantFact, VolumeFact } from '../tenant-health/service.js';

const notify = vi.hoisted(() => ({
  failover: vi.fn(async () => undefined),
  misplaced: vi.fn(async () => undefined),
}));
vi.mock('../notifications/events.js', () => ({
  notifyAdminTenantStorageFailover: notify.failover,
  notifyAdminTenantMisplaced: notify.misplaced,
}));

const { runPlacementTick } = await import('./reconciler.js');
const { readPinRepairState } = await import('./pin-repair.js');

// CI's integration job provides DATABASE_URL; locally, point either at a throwaway
// Postgres. Every table lives in this file's own schema, never the database's own.
const url = process.env.PLACEMENT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const MIGRATION = fileURLToPath(new URL('../../db/migrations/0141_tenant_placement.sql', import.meta.url));
const SALVAGE = '2026-10-02T05:09:29Z';

const tenantFact = (id: string, name: string, over: Partial<TenantFact> = {}): TenantFact => ({
  id, name, namespace: `tenant-${id}`, storageTier: 'local', pinnedNode: 'node-a', status: 'active',
  hasMailboxes: false, ...over,
});
const pod = (ns: string, node: string): PodFact => ({
  namespace: ns, name: `app-${node}`, nodeName: node, ready: true, phase: 'Running', createdAt: null,
  controllerKind: 'ReplicaSet',
});
const vol = (ns: string, node: string | null, remount: string | null = null): VolumeFact => ({
  volumeName: `pvc-${ns}`, namespace: ns, pvcName: `${ns}-storage`, robustness: 'healthy',
  attached: node !== null, pvcRefLostAt: null, attachedNode: node, remountRequestedAt: remount,
});
const rep = (ns: string, node: string): ReplicaFact => ({ volumeName: `pvc-${ns}`, nodeId: node, running: true, failed: false });

/** acme + bright salvaged and now on node-b; cedar placed on node-a. */
function incidentFacts(over: Partial<CollectedFacts> = {}): CollectedFacts {
  return {
    nodes: [], endpoints: [], mailActiveNode: null, nodesAsOf: null, readError: null,
    tenants: [tenantFact('acme', 'Acme School'), tenantFact('bright', 'Bright Academy'), tenantFact('cedar', 'Cedar Institute')],
    pods: [pod('tenant-acme', 'node-b'), pod('tenant-bright', 'node-b'), pod('tenant-cedar', 'node-a')],
    volumes: [vol('tenant-acme', 'node-b', SALVAGE), vol('tenant-bright', 'node-b', SALVAGE), vol('tenant-cedar', 'node-a')],
    replicas: [rep('tenant-acme', 'node-b'), rep('tenant-bright', 'node-b'), rep('tenant-cedar', 'node-a')],
    ...over,
  };
}

/** A fake apps API: cedar's two Deployments lost their pin; acme's never had one. */
function fakeK8s() {
  const deployments: Record<string, Array<{ metadata: { name: string; generation: number }; spec: { replicas: number; template: { spec: { nodeSelector?: Record<string, string> } } } }>> = {
    'tenant-cedar': [
      { metadata: { name: 'moodle', generation: 3 }, spec: { replicas: 1, template: { spec: {} } } },
      { metadata: { name: 'file-manager', generation: 1 }, spec: { replicas: 0, template: { spec: {} } } },
    ],
    'tenant-acme': [{ metadata: { name: 'moodle', generation: 2 }, spec: { replicas: 1, template: { spec: {} } } }],
  };
  const patches: Array<{ namespace: string; name: string; body: unknown }> = [];
  const apps = {
    listNamespacedDeployment: vi.fn(async ({ namespace }: { namespace: string }) => ({ items: deployments[namespace] ?? [] })),
    patchNamespacedDeployment: vi.fn(async (req: { namespace: string; name: string; body: unknown }) => { patches.push(req); return {}; }),
    readNamespacedDeployment: vi.fn(async () => ({
      metadata: { generation: 4 }, spec: { replicas: 1 },
      status: { observedGeneration: 4, replicas: 1, updatedReplicas: 1, availableReplicas: 1 },
    })),
  };
  return { k8s: { apps } as never, patches };
}

describe.skipIf(!url)('placement reconciler tick (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeAll(async () => {
    // Own schema: vitest runs the real-DB files in parallel against one database.
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=placement_reconciler_test' });
    await pool.query('DROP SCHEMA IF EXISTS placement_reconciler_test CASCADE');
    await pool.query('CREATE SCHEMA placement_reconciler_test');
    await pool.query('DROP TABLE IF EXISTS tenant_storage_failovers, tenant_placement_state, tenants, platform_settings CASCADE');
    await pool.query(`CREATE TABLE tenants (id varchar(36) PRIMARY KEY, kubernetes_namespace varchar(63),
      storage_lifecycle_state varchar(32) NOT NULL DEFAULT 'idle')`);
    await pool.query(`CREATE TABLE platform_settings (setting_key varchar(100) PRIMARY KEY, setting_value text NOT NULL,
      updated_at timestamp NOT NULL DEFAULT now())`);
    await pool.query(readFileSync(MIGRATION, 'utf8'));
    db = drizzle(pool, { schema }) as unknown as Database;
  });

  afterAll(async () => {
    await pool?.query('DROP SCHEMA IF EXISTS placement_reconciler_test CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE tenant_storage_failovers, tenant_placement_state, tenants, platform_settings CASCADE');
    await pool.query(`INSERT INTO tenants (id, kubernetes_namespace) VALUES
      ('acme', 'tenant-acme'), ('bright', 'tenant-bright'), ('cedar', 'tenant-cedar')`);
    notify.failover.mockClear();
    notify.misplaced.mockClear();
    process.env.TENANT_PIN_REPAIR = 'disable';
  });

  const tick = (iso: string, facts = incidentFacts(), k8s: never = fakeK8s().k8s, awaitRepair = false) =>
    runPlacementTick({
      db, k8s, collect: async () => facts, now: () => new Date(iso), awaitRepair,
      logger: { info: () => undefined, warn: () => undefined },
    });

  it('announces the salvage once, as one notification naming both tenants and the move', async () => {
    const r1 = await tick('2026-10-02T05:10:30Z');
    expect(r1.newFailovers).toBe(2);
    expect(notify.failover).toHaveBeenCalledTimes(1);
    const [, payload, tenantId] = notify.failover.mock.calls[0] as unknown as [unknown, { summary: string; details: string }, string | undefined];
    expect(payload.summary).toBe('2 tenants');
    expect(payload.details).toContain('Acme School: volume tenant-acme-storage salvaged at 2026-10-02 05:09 UTC');
    expect(payload.details).toContain('no longer on its primary node node-a');
    expect(tenantId).toBeUndefined();

    // Longhorn keeps remountRequestedAt on the volume: every later tick sees it.
    await tick('2026-10-02T05:11:30Z');
    expect(notify.failover).toHaveBeenCalledTimes(1);
  });

  it('records but does not announce a salvage older than the window (first run on a cluster)', async () => {
    const r = await tick('2026-10-02T23:00:00Z');
    expect(r.newFailovers).toBe(2);
    expect(r.failoversNotified).toBe(0);
    expect(notify.failover).not.toHaveBeenCalled();
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM tenant_storage_failovers');
    expect(rows[0].n).toBe(2);
  });

  it('marks the moved tenants misplaced and notifies once, only after ten minutes', async () => {
    await tick('2026-10-02T05:10:30Z');
    const { rows } = await pool.query("SELECT tenant_id, status, actual_nodes FROM tenant_placement_state ORDER BY tenant_id");
    expect(rows).toEqual([
      { tenant_id: 'acme', status: 'misplaced', actual_nodes: ['node-b'] },
      { tenant_id: 'bright', status: 'misplaced', actual_nodes: ['node-b'] },
      { tenant_id: 'cedar', status: 'placed', actual_nodes: ['node-a'] },
    ]);
    await tick('2026-10-02T05:15:30Z');
    expect(notify.misplaced).not.toHaveBeenCalled();

    const r = await tick('2026-10-02T05:21:30Z');
    expect(r.misplacedNotified).toBe(2);
    expect(notify.misplaced).toHaveBeenCalledTimes(1);
    await tick('2026-10-02T05:30:30Z');
    expect(notify.misplaced).toHaveBeenCalledTimes(1);
  });

  it('an incomplete cluster read changes nothing and starts nothing', async () => {
    await tick('2026-10-02T05:10:30Z');
    delete process.env.TENANT_PIN_REPAIR;
    const { k8s, patches } = fakeK8s();
    const r = await tick('2026-10-02T05:11:30Z', incidentFacts({ readError: 'pods: timeout' }), k8s, true);
    expect(r.repairStarted).toBe(false);
    expect(patches).toEqual([]);
    const { rows } = await pool.query("SELECT status FROM tenant_placement_state WHERE tenant_id = 'acme'");
    expect(rows[0].status).toBe('misplaced');
  });

  it('re-pins only the tenant that is where it belongs, one Deployment at a time, exactly once', async () => {
    delete process.env.TENANT_PIN_REPAIR;
    const { k8s, patches } = fakeK8s();
    const r1 = await tick('2026-10-02T05:10:30Z', incidentFacts(), k8s, true);
    expect(r1.repairStarted).toBe(true);
    // Cedar (placed) gets its pin back; Acme (misplaced) is not dragged back.
    expect(patches.map((p) => `${p.namespace}/${p.name}`)).toEqual(['tenant-cedar/moodle', 'tenant-cedar/file-manager']);
    expect(patches[0]!.body).toEqual({ spec: { template: { spec: { nodeSelector: { 'kubernetes.io/hostname': 'node-a' } } } } });

    const state = await readPinRepairState(db);
    expect(state?.state).toBe('done');
    expect(state?.repaired).toEqual(['tenant-cedar/moodle', 'tenant-cedar/file-manager']);
    expect(state?.skipped?.some((s) => s.startsWith('Acme School: misplaced'))).toBe(true);

    const again = fakeK8s();
    const r2 = await tick('2026-10-02T06:10:30Z', incidentFacts(), again.k8s, true);
    expect(r2.repairStarted).toBe(false);
    expect(again.patches).toEqual([]);
  });
});

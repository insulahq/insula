/**
 * The connection poll against a REAL Postgres: a worker frps reports online
 * leaves `pending`, gets a last-seen time and one `connect` audit row — and
 * not one per poll. Production: a connected worker stayed "pending" with no
 * last-seen time, because nothing ever told the platform.
 *
 * Runs in the integration suite (DATABASE_URL). Tables live in this file's own schema.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { pollPrivateWorkerConnections } from './connection-poller.js';

const url = process.env.DATABASE_URL;
const TENANT = '33333333-0000-4000-8000-000000000001';
const NS = 'tenant-example-0a1b2c3d';

describe.skipIf(!url)('private-worker connection poll (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Database;
  let online: number[] = [];
  let calls: Array<{ url: string; auth: string }> = [];

  const k8s = {
    core: {
      listNamespacedPod: async () => ({ items: [{ status: { phase: 'Running', podIP: '10.42.0.9' }, metadata: {} }] }),
    },
  } as unknown as K8sClients;
  const fetcher = async (u: string, init: { headers: Record<string, string> }) => {
    calls.push({ url: u, auth: init.headers.authorization });
    return {
      ok: true, status: 200,
      json: async () => ({ proxies: online.map((p) => ({ status: 'online', conf: { remotePort: p } })) }),
    };
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=pw_poll_test' });
    await pool.query('DROP SCHEMA IF EXISTS pw_poll_test CASCADE');
    await pool.query('CREATE SCHEMA pw_poll_test');
    await pool.query("CREATE TYPE pw_poll_test.private_worker_status AS ENUM ('pending','active','revoked','suspended')");
    await pool.query(`CREATE TABLE tenants (id varchar(36) PRIMARY KEY, kubernetes_namespace text, status text NOT NULL,
      private_worker_shared_secret varchar(64))`);
    await pool.query(`CREATE TABLE private_workers (id varchar(36) PRIMARY KEY, tenant_id varchar(36) NOT NULL,
      status pw_poll_test.private_worker_status NOT NULL DEFAULT 'pending', exposed_port integer NOT NULL,
      last_seen_at timestamp, updated_at timestamp NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE private_worker_audit (id bigserial PRIMARY KEY, private_worker_id varchar(36) NOT NULL,
      event varchar(40) NOT NULL, ip inet, detail jsonb, occurred_at timestamp NOT NULL DEFAULT now())`);
    db = drizzle(pool, { schema }) as unknown as Database;
  });

  afterAll(async () => {
    await pool?.query('DROP SCHEMA IF EXISTS pw_poll_test CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    online = [];
    calls = [];
    await pool.query('TRUNCATE tenants, private_workers, private_worker_audit');
    await pool.query("INSERT INTO tenants VALUES ($1, $2, 'active', 'shared-secret')", [TENANT, NS]);
    await pool.query(`INSERT INTO private_workers (id, tenant_id, status, exposed_port) VALUES
      ('w1', $1, 'pending', 10000), ('w2', $1, 'pending', 10001), ('w3', $1, 'revoked', 10002)`, [TENANT]);
  });

  const workers = async () => (await pool.query(
    "SELECT id, status::text, last_seen_at IS NOT NULL AS seen FROM private_workers ORDER BY id",
  )).rows;
  const audits = async () => Number((await pool.query("SELECT count(*) FROM private_worker_audit WHERE event = 'connect'")).rows[0].count);

  it('★ a connected worker becomes active with a last-seen time; one that is not stays pending', async () => {
    online = [10000, 10002];
    expect(await pollPrivateWorkerConnections(db, k8s, fetcher)).toEqual({ tenants: 1, unreadable: 0, connected: 1 });
    expect(await workers()).toEqual([
      { id: 'w1', status: 'active', seen: true },
      { id: 'w2', status: 'pending', seen: false },
      // A revoked worker is not polled for and not revived.
      { id: 'w3', status: 'revoked', seen: false },
    ]);
    expect(calls[0].url).toBe('http://10.42.0.9:7500/api/proxy/tcp');
    expect(calls[0].auth).toMatch(/^Basic /);
  });

  it('writes one connect row per connection, not one per poll', async () => {
    online = [10000];
    await pollPrivateWorkerConnections(db, k8s, fetcher);
    await pollPrivateWorkerConnections(db, k8s, fetcher);
    expect(await audits()).toBe(1);
    // Back after a long gap: a new connection.
    await pool.query("UPDATE private_workers SET last_seen_at = now() - interval '1 hour' WHERE id = 'w1'");
    await pollPrivateWorkerConnections(db, k8s, fetcher);
    expect(await audits()).toBe(2);
  });

  it('an unreadable frps changes nothing', async () => {
    const down = async () => ({ ok: false, status: 401, json: async () => ({}) });
    expect(await pollPrivateWorkerConnections(db, k8s, down)).toMatchObject({ unreadable: 1, connected: 0 });
    expect((await workers()).every((w) => w.status !== 'active')).toBe(true);
  });
});

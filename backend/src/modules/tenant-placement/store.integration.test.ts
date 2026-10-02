/**
 * The placement store against a REAL Postgres. The upsert keeps a
 * misplacement's clock and its notification claim by reading the EXISTING row
 * inside ON CONFLICT DO UPDATE — exactly the SQL an in-memory fake or a mocked
 * client would happily agree with while Postgres does something else.
 *
 * Runs in the integration suite (DATABASE_URL) or against a throwaway database:
 *   docker run -d --rm --name pl-pg -p 55432:5432 -e POSTGRES_PASSWORD=x postgres:18-alpine
 *   PLACEMENT_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55432/postgres \
 *     vitest run --config vitest.config.integration.ts src/modules/tenant-placement/store.integration.test.ts
 * It creates its own minimal `tenants` table and applies migration 0141.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { TenantPlacementObservation } from './compute.js';
import {
  claimMisplacedNotifications, getPlacement, loadPlacementStates, recordStorageFailovers, savePlacementStates,
} from './store.js';

// CI's integration job provides DATABASE_URL; locally, point either at a throwaway
// Postgres. Every table lives in this file's own schema, never the database's own.
const url = process.env.PLACEMENT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const MIGRATION = fileURLToPath(new URL('../../db/migrations/0141_tenant_placement.sql', import.meta.url));

const obs = (over: Partial<TenantPlacementObservation> = {}): TenantPlacementObservation => ({
  tenantId: 't1', tenantName: 'Acme', status: 'placed', primaryNode: 'node-a', storageTier: 'local',
  workloadNodes: ['node-a'], attachedNodes: ['node-a'], dataNodes: ['node-a'], actualNodes: ['node-a'], reasons: [],
  ...over,
});
const misplaced = obs({
  status: 'misplaced', workloadNodes: ['node-b'], attachedNodes: ['node-b'], dataNodes: ['node-b'],
  actualNodes: ['node-b'], reasons: ['running on node-b', 'data on node-b'],
});
const at = (iso: string) => new Date(iso);

describe.skipIf(!url)('tenant placement store (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeAll(async () => {
    // Own schema: vitest runs the real-DB files in parallel against one database.
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=placement_store_test' });
    await pool.query('DROP SCHEMA IF EXISTS placement_store_test CASCADE');
    await pool.query('CREATE SCHEMA placement_store_test');
    await pool.query('DROP TABLE IF EXISTS tenant_storage_failovers, tenant_placement_state, tenants CASCADE');
    await pool.query('CREATE TABLE tenants (id varchar(36) PRIMARY KEY)');
    await pool.query(readFileSync(MIGRATION, 'utf8'));
    // Replay-safe, as the migration header promises.
    await pool.query(readFileSync(MIGRATION, 'utf8'));
    db = drizzle(pool, { schema }) as unknown as Database;
  });

  afterAll(async () => {
    await pool?.query('DROP SCHEMA IF EXISTS placement_store_test CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE tenant_storage_failovers, tenant_placement_state, tenants CASCADE');
    await pool.query("INSERT INTO tenants (id) VALUES ('t1'), ('t2')");
  });

  it('keeps the misplacement clock across ticks and clears it when the tenant is back', async () => {
    await savePlacementStates(db, [misplaced], at('2026-10-02T05:10:00Z'));
    await savePlacementStates(db, [misplaced], at('2026-10-02T05:11:00Z'));
    let row = await getPlacement(db, 't1');
    expect(row?.status).toBe('misplaced');
    expect(row?.misplacedSince?.toISOString()).toBe('2026-10-02T05:10:00.000Z');
    expect(row?.checkedAt.toISOString()).toBe('2026-10-02T05:11:00.000Z');
    expect(row?.actualNodes).toEqual(['node-b']);
    expect(row?.reasons).toEqual(['running on node-b', 'data on node-b']);

    await savePlacementStates(db, [obs()], at('2026-10-02T06:00:00Z'));
    row = await getPlacement(db, 't1');
    expect(row?.status).toBe('placed');
    expect(row?.misplacedSince).toBeNull();
  });

  it('never lets an incomplete read overwrite known facts', async () => {
    await savePlacementStates(db, [misplaced], at('2026-10-02T05:10:00Z'));
    await savePlacementStates(db, [obs({ status: 'unknown', reasons: [] }), obs({ tenantId: 't2', status: 'unknown' })], at('2026-10-02T05:11:00Z'));
    const all = await loadPlacementStates(db);
    expect(all.get('t1')?.status).toBe('misplaced');
    expect(all.get('t1')?.misplacedSince?.toISOString()).toBe('2026-10-02T05:10:00.000Z');
    expect(all.get('t2')?.status).toBe('unknown');
  });

  it('claims each misplacement notification once, only after the hysteresis, and re-arms after recovery', async () => {
    const tenMin = 10 * 60_000;
    await savePlacementStates(db, [misplaced], at('2026-10-02T05:10:00Z'));
    expect(await claimMisplacedNotifications(db, at('2026-10-02T05:15:00Z'), tenMin)).toEqual([]);

    const first = await claimMisplacedNotifications(db, at('2026-10-02T05:21:00Z'), tenMin);
    expect(first.map((p) => p.tenantId)).toEqual(['t1']);
    // A second replica in the same minute, and every later tick: nothing.
    expect(await claimMisplacedNotifications(db, at('2026-10-02T05:21:00Z'), tenMin)).toEqual([]);
    await savePlacementStates(db, [misplaced], at('2026-10-02T05:22:00Z'));
    expect(await claimMisplacedNotifications(db, at('2026-10-02T05:40:00Z'), tenMin)).toEqual([]);

    // Back on its node, then away again: a new episode, a new notification.
    await savePlacementStates(db, [obs()], at('2026-10-02T06:00:00Z'));
    await savePlacementStates(db, [misplaced], at('2026-10-02T07:00:00Z'));
    const again = await claimMisplacedNotifications(db, at('2026-10-02T07:11:00Z'), tenMin);
    expect(again.map((p) => p.misplacedSince?.toISOString())).toEqual(['2026-10-02T07:00:00.000Z']);
  });

  it('records a salvage once however many times it is seen, with where the tenant was and is', async () => {
    const event = {
      tenantId: 't1', tenantName: 'Acme', volumeName: 'pvc-1', pvcName: 'acme-storage',
      remountRequestedAt: '2026-10-02T05:09:29.000Z',
    };
    const before = new Map([['t1', { actualNodes: ['node-a'] } as never]]);
    const after = new Map([['t1', misplaced]]);
    const first = await recordStorageFailovers(db, [event], before, after);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ volumeName: 'pvc-1', nodesBefore: ['node-a'], nodesAfter: ['node-b'] });
    expect(first[0]!.remountRequestedAt.toISOString()).toBe('2026-10-02T05:09:29.000Z');

    expect(await recordStorageFailovers(db, [event], before, after)).toEqual([]);
    // A later salvage of the same volume is a new event.
    expect(await recordStorageFailovers(db, [{ ...event, remountRequestedAt: '2026-10-03T01:00:00.000Z' }], before, after)).toHaveLength(1);
  });
});

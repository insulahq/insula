/**
 * The grace gate against a REAL Postgres.
 *
 * `episodePastGraceSql()` decides when the healer scales a tenant's workloads
 * to zero and when both dashboards call a tenant down. It is a CASE over an
 * EXISTS with three bound intervals — SQL that a mocked client agrees with
 * whatever it says. The ages below are set by the database's own clock.
 *
 * Runs in the integration suite (DATABASE_URL) or against a throwaway database
 * (WORKLOAD_HEALTH_TEST_DATABASE_URL). Every table lives in this file's own schema.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { FAILOVER_GRACE_MS, FAILOVER_RECENT_MS, GRACE_MS, episodePastGraceSql, recordDownEpisode } from './workload-health.js';

const url = process.env.WORKLOAD_HEALTH_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const migration = (name: string) => readFileSync(fileURLToPath(new URL(`../../db/migrations/${name}`, import.meta.url)), 'utf8');

describe.skipIf(!url)('workload-health grace gate (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=workload_health_gate_test' });
    await pool.query('DROP SCHEMA IF EXISTS workload_health_gate_test CASCADE');
    await pool.query('CREATE SCHEMA workload_health_gate_test');
    await pool.query('CREATE TABLE tenants (id varchar(36) PRIMARY KEY)');
    await pool.query(migration('0135_tenant_workload_health_episodes.sql'));
    await pool.query(migration('0141_tenant_placement.sql'));
    await pool.query(migration('0186_tenant_placement_spare_copies.sql'));
    db = drizzle(pool, { schema }) as unknown as Database;
  });

  afterAll(async () => {
    await pool?.query('DROP SCHEMA IF EXISTS workload_health_gate_test CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE tenant_workload_health_events, tenant_storage_failovers, tenants CASCADE');
    await pool.query(`INSERT INTO tenants (id) VALUES ('t1'), ('t2')`);
  });

  /** An open episode first seen `ageSec` ago. */
  const episode = (workload: string, reason: string, ageSec: number, tenant = 't1') => pool.query(
    `INSERT INTO tenant_workload_health_events (tenant_id, workload, namespace, desired_replicas, reason, first_seen_at)
     VALUES ($1, $2, 'tenant-acme', 1, $3, now() - make_interval(secs => $4))`,
    [tenant, workload, reason, ageSec],
  );
  /** A recorded salvage `agoSec` ago. */
  const failover = (agoSec: number, tenant = 't1', volume = 'pvc-1') => pool.query(
    `INSERT INTO tenant_storage_failovers (id, tenant_id, volume_name, remount_requested_at)
     VALUES (gen_random_uuid()::text, $1, $2, now() - make_interval(secs => $3))`,
    [tenant, volume, agoSec],
  );
  const due = async (): Promise<string[]> => {
    const res = await db.execute<{ workload: string }>(sql`
      SELECT e.workload FROM tenant_workload_health_events e
       WHERE e.cleared_at IS NULL AND ${episodePastGraceSql()}
       ORDER BY e.workload`);
    return (res.rows ?? []).map((r) => r.workload);
  };

  const SHORT = FAILOVER_GRACE_MS / 1000;
  const LONG = GRACE_MS / 1000;

  it('the windows are the ones the tests below assume', () => {
    expect(SHORT).toBeLessThan(LONG);
    expect(FAILOVER_RECENT_MS / 1000).toBeGreaterThan(LONG);
  });

  it('acts early on a volume that will not mount right after a recorded salvage', async () => {
    await failover(SHORT + 120);
    await episode('just-under', 'volume_attach', SHORT - 30);
    await episode('just-over', 'volume_attach', SHORT + 30);
    expect(await due()).toEqual(['just-over']);
  });

  it('keeps the full window when no salvage was recorded', async () => {
    await episode('no-failover', 'volume_attach', SHORT + 30);
    await episode('long-down', 'volume_attach', LONG + 30);
    expect(await due()).toEqual(['long-down']);
  });

  it('keeps the full window for a workload that is merely slow to come back after the salvage', async () => {
    await failover(SHORT + 120);
    // A database in crash recovery is "not ready" (unknown); a replacement pod
    // refused while its predecessor terminates is quota_rejected. Re-staging
    // the volume under either would only restart the wait.
    await episode('recovering', 'unknown', SHORT + 30);
    await episode('refused', 'quota_rejected', SHORT + 30);
    await episode('crashing', 'crash', SHORT + 30);
    expect(await due()).toEqual([]);
  });

  it('does not put an unmountable volume down to a salvage that is long past', async () => {
    await failover(FAILOVER_RECENT_MS / 1000 + 60);
    await episode('old-salvage', 'volume_attach', SHORT + 30);
    expect(await due()).toEqual([]);
  });

  it('does not borrow another tenant\'s salvage', async () => {
    await failover(SHORT + 120, 't2');
    await episode('mine', 'volume_attach', SHORT + 30, 't1');
    await episode('theirs', 'volume_attach', SHORT + 30, 't2');
    expect(await due()).toEqual(['theirs']);
  });

  it('every cause is past grace once the full window is over, salvage or not', async () => {
    await failover(SHORT + 120);
    await episode('a-attach', 'volume_attach', LONG + 30);
    await episode('b-unknown', 'unknown', LONG + 30);
    await episode('c-other-tenant', 'image', LONG + 30, 't2');
    await episode('d-young', 'unknown', LONG - 30);
    expect(await due()).toEqual(['a-attach', 'b-unknown', 'c-other-tenant']);
  });

  it('several salvages of one tenant still make one row per episode', async () => {
    await failover(SHORT + 120, 't1', 'pvc-1');
    await failover(SHORT + 200, 't1', 'pvc-2');
    await episode('once', 'volume_attach', SHORT + 30);
    expect(await due()).toEqual(['once']);
  });

  // ── a relapse: new pods or the old outage? (recordDownEpisode) ──
  //
  // Lab DEV: a Moodle episode cleared at its first start; the upgrade an hour
  // later rolled the pod and the reopened episode kept its old clock — past
  // the grace window at once, re-staged with its database 16 s after the click.
  /** An episode that started `startedSec` ago, was healed once and cleared `clearedSec` ago. */
  const cleared = (workload: string, startedSec: number, clearedSec: number) => pool.query(
    `INSERT INTO tenant_workload_health_events
       (tenant_id, workload, namespace, desired_replicas, reason, first_seen_at, cleared_at, heal_attempts, last_heal_at)
     VALUES ('t1', $1, 'tenant-acme', 1, 'unknown', now() - make_interval(secs => $2), now() - make_interval(secs => $3), 1,
             now() - make_interval(secs => $2))`,
    [workload, startedSec, clearedSec],
  );
  const reopen = (workload: string, oldestPodAgoSec: number | null) => recordDownEpisode(db, {
    tenantId: 't1', workload, namespace: 'tenant-acme', desired: 1, available: 0, reason: 'not_ready', detail: null,
    oldestLivePodAt: oldestPodAgoSec === null ? null : new Date(Date.now() - oldestPodAgoSec * 1000),
  });
  const row = async (workload: string) => (await pool.query(
    `SELECT EXTRACT(EPOCH FROM now() - first_seen_at)::int AS age, heal_attempts, cleared_at FROM tenant_workload_health_events WHERE workload = $1`,
    [workload],
  )).rows[0] as { age: number; heal_attempts: number; cleared_at: Date | null };

  it('a relapse of pods created after the episode cleared starts a new grace window; the heal budget carries over', async () => {
    await cleared('upgraded', 50 * 60, 30 * 60);
    expect(await reopen('upgraded', 20)).toBe(true);
    const r = await row('upgraded');
    expect(r.age).toBeLessThan(5);
    expect(r.heal_attempts).toBe(1);
    expect(r.cleared_at).toBeNull();
    expect(await due()).toEqual([]);
  });

  it('a relapse of the same pods carries the old outage on, past the grace window at once', async () => {
    await cleared('flapping', 50 * 60, 30 * 60);
    await reopen('flapping', 40 * 60);
    expect((await row('flapping')).age).toBeGreaterThan(49 * 60);
    expect(await due()).toEqual(['flapping']);
  });

  it('pods it could not read leave the old rule in place', async () => {
    await cleared('unread', 50 * 60, 30 * 60);
    await reopen('unread', null);
    expect(await due()).toEqual(['unread']);
  });

  it('an open episode keeps its clock whatever its pods', async () => {
    await episode('still-down', 'unknown', LONG + 30);
    await reopen('still-down', 5);
    expect(await due()).toEqual(['still-down']);
  });
});

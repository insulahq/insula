/**
 * Storing drift rows against a REAL Postgres, with the table and its index as
 * the migration creates them.
 *
 * Two sync passes can find the same new drift item at the same moment — the
 * timer's pass on one replica and an explicit run on another, or a lease taken
 * over mid-pass. Both read "not active", both insert, and the index that
 * allows one active row per item refuses the second. That refusal used to be
 * reported as "drift rows could not be stored" although the row was stored.
 *
 * Needs a database — CI's integration job provides DATABASE_URL.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { reconcileDriftItems } from './principals-sync.js';

const url = process.env.LEASE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const SCHEMA = 'mail_drift_race_test';

describe.skipIf(!url)('drift rows (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Parameters<typeof reconcileDriftItems>[0];

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    // The table, its checks and the one-active-row index, from the migration itself.
    await pool.query(readFileSync(join(import.meta.dirname, '../../db/migrations/0032_mail_drift_items.sql'), 'utf8'));
    // The kinds the detector emits today (later migrations only widened this list).
    await pool.query(`ALTER TABLE mail_drift_items DROP CONSTRAINT mail_drift_kind_check`);
    await pool.query(`ALTER TABLE mail_drift_items ADD CONSTRAINT mail_drift_kind_check
      CHECK (kind IN ('domain','mailbox','master-user','orphan-domain','orphan-list','alias','orphan-alias'))`);
    db = drizzle(pool) as unknown as Parameters<typeof reconcileDriftItems>[0];
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE mail_drift_items');
  });

  const item = (n: number) => ({
    kind: 'mailbox' as const,
    expectedName: `box${n}@example.test`,
    expectedStalwartId: null,
    platformRowId: `00000000-0000-4000-8000-00000000000${n}`,
  });
  const active = async (): Promise<number> =>
    Number((await pool.query('SELECT count(*) AS n FROM mail_drift_items WHERE resolved_at IS NULL')).rows[0].n);

  it('two passes that find the same new item: one stores and reports it, neither fails', async () => {
    const failuresA: string[] = [];
    const failuresB: string[] = [];
    const [newA, newB] = await Promise.all([
      reconcileDriftItems(db, [item(1), item(2)], failuresA),
      reconcileDriftItems(db, [item(1), item(2)], failuresB),
    ]);

    expect(failuresA).toEqual([]);
    expect(failuresB).toEqual([]);
    // Each item is new to exactly one pass — that pass sends the alert.
    expect([...newA, ...newB].map((i) => i.platformRowId).sort()).toEqual([item(1).platformRowId, item(2).platformRowId]);
    expect(await active()).toBe(2);
  });

  it('an item already active is seen again, not stored twice and not new', async () => {
    await reconcileDriftItems(db, [item(1)]);
    const failures: string[] = [];
    expect(await reconcileDriftItems(db, [item(1)], failures)).toEqual([]);
    expect(failures).toEqual([]);
    expect(await active()).toBe(1);
  });

  it('an item that drifts again after it was resolved is a new row, and new', async () => {
    await reconcileDriftItems(db, [item(1)]);
    await reconcileDriftItems(db, []);            // gone from the scan → resolved
    expect(await active()).toBe(0);

    expect(await reconcileDriftItems(db, [item(1)])).toHaveLength(1);
    expect(await active()).toBe(1);
    expect(Number((await pool.query('SELECT count(*) AS n FROM mail_drift_items')).rows[0].n)).toBe(2);
  });

  it('an item an operator dismissed while the scan was running keeps that resolution', async () => {
    await reconcileDriftItems(db, [item(1)]);
    // A scan in which the item no longer shows: it reads the active list —
    // and before it resolves what is gone, an operator dismisses the item.
    const real = db as unknown as {
      select: (cols: unknown) => { from: (t: unknown) => { where: (w: unknown) => Promise<unknown[]> } };
      update: (...a: unknown[]) => unknown;
      insert: (...a: unknown[]) => unknown;
    };
    const dismissedMeanwhile = {
      select: (cols: unknown) => ({
        from: (table: unknown) => ({
          where: async (cond: unknown) => {
            const rows = await real.select(cols).from(table).where(cond);
            await pool.query(`UPDATE mail_drift_items SET resolved_at = now(), resolved_via = 'dismissed' WHERE resolved_at IS NULL`);
            return rows;
          },
        }),
      }),
      update: (...a: unknown[]) => real.update(...a),
      insert: (...a: unknown[]) => real.insert(...a),
    } as unknown as Parameters<typeof reconcileDriftItems>[0];

    await reconcileDriftItems(dismissedMeanwhile, []);

    const { rows } = await pool.query('SELECT resolved_via FROM mail_drift_items');
    expect(rows).toEqual([{ resolved_via: 'dismissed' }]);
  });

  it('a row the database really refuses is still reported, and costs only that row', async () => {
    const failures: string[] = [];
    const bogus = { ...item(3), kind: 'no-such-kind' as never };
    const stored = await reconcileDriftItems(db, [bogus, item(1)], failures);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('no-such-kind');
    expect(stored.map((i) => i.platformRowId)).toEqual([item(1).platformRowId]);
    expect(await active()).toBe(1);
  });
});

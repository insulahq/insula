/**
 * Resolved History keeps 30 days, against a REAL Postgres: the reaper and the
 * list must agree on the window, and the history must never crowd active items
 * off the page.
 *
 * Needs a database — CI's integration job provides DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { reapResolvedDriftItems, RESOLVED_DRIFT_RETENTION_DAYS } from './retention.js';
import { listDriftItems } from './service.js';

const url = process.env.DRIFT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!url)('mail drift resolved history (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=mail_drift_retention_test' });
    await pool.query('DROP SCHEMA IF EXISTS mail_drift_retention_test CASCADE');
    await pool.query('CREATE SCHEMA mail_drift_retention_test');
    await pool.query(`CREATE TABLE mail_drift_items (id varchar(36) PRIMARY KEY, kind varchar(16) NOT NULL,
      expected_name varchar(255) NOT NULL, expected_stalwart_id varchar(64), platform_row_id varchar(36) NOT NULL,
      first_detected_at timestamp NOT NULL DEFAULT now(), last_seen_at timestamp NOT NULL DEFAULT now(),
      resolved_at timestamp, resolved_via varchar(32), notes text)`);
    db = drizzle(pool, { schema }) as unknown as Database;
  });

  afterAll(async () => {
    await pool?.query('DROP SCHEMA IF EXISTS mail_drift_retention_test CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE mail_drift_items');
  });

  /** A drift row first seen `seenDaysAgo`, resolved `resolvedDaysAgo` (null = still active). */
  async function row(id: string, seenDaysAgo: number, resolvedDaysAgo: number | null): Promise<void> {
    await pool.query(
      `INSERT INTO mail_drift_items (id, kind, expected_name, platform_row_id, first_detected_at, resolved_at, resolved_via)
       VALUES ($1::text, 'alias', $1::text || '@example.test', $1::text, now() - make_interval(days => $2::int),
               CASE WHEN $3::int IS NULL THEN NULL ELSE now() - make_interval(days => $3::int) END,
               CASE WHEN $3::int IS NULL THEN NULL ELSE 'reappeared' END)`,
      [id, seenDaysAgo, resolvedDaysAgo],
    );
  }

  it('keeps 30 days', () => {
    expect(RESOLVED_DRIFT_RETENTION_DAYS).toBe(30);
  });

  it('reaps only items resolved more than 30 days ago — never an active one', async () => {
    await row('active-old', 90, null);
    await row('recent', 40, 10);
    await row('edge', 40, 29);
    await row('stale', 60, 31);
    await row('ancient', 400, 365);

    expect(await reapResolvedDriftItems(db)).toBe(2);
    const { rows } = await pool.query('SELECT id FROM mail_drift_items ORDER BY id');
    expect(rows.map((r: { id: string }) => r.id)).toEqual(['active-old', 'edge', 'recent']);
  });

  it('lists every active item and only the last 30 days of history', async () => {
    await row('active-old', 90, null);
    await row('recent', 40, 10);
    await row('stale', 60, 31);

    const { items, hasActive } = await listDriftItems(db);
    expect(items.map((i) => i.id)).toEqual(['active-old', 'recent']);
    expect(hasActive).toBe(true);
  });

  it('a long history never pushes an old active item off the page', async () => {
    await row('active-old', 200, null);
    for (let i = 0; i < 120; i++) await row(`res-${String(i).padStart(3, '0')}`, 1, 0);

    const { items } = await listDriftItems(db);
    expect(items.some((i) => i.id === 'active-old')).toBe(true);
    expect(items.filter((i) => i.resolvedAt !== null)).toHaveLength(100);
  });
});

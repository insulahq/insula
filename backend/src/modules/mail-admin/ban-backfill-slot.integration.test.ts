/**
 * The shared "existing bans were checked" stamp, against a REAL Postgres.
 *
 * Three platform-api replicas, and each one's in-process memory resets on every
 * restart — so "when did the backfill last run, and for which lifetime" lives in
 * platform_settings, claimed in one atomic statement on the database clock.
 *
 * Needs a database — CI's integration job provides DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { claimBanBackfillSlot, releaseBanBackfillSlot } from './ban-backfill-slot.js';

const url = process.env.SLOT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!url)('ban backfill slot (real Postgres)', () => {
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle>;
  const H = 3_600_000;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=ban_backfill_slot_test' });
    await pool.query('DROP SCHEMA IF EXISTS ban_backfill_slot_test CASCADE');
    await pool.query('CREATE SCHEMA ban_backfill_slot_test');
    await pool.query(`CREATE TABLE platform_settings (setting_key varchar(100) PRIMARY KEY, setting_value text NOT NULL,
      updated_at timestamp NOT NULL DEFAULT now())`);
    db = drizzle(pool);
  });
  afterAll(async () => {
    await pool?.query('DROP SCHEMA IF EXISTS ban_backfill_slot_test CASCADE');
    await pool?.end();
  });
  beforeEach(async () => { await pool.query('TRUNCATE platform_settings'); });

  const age = (minutes: number) => pool.query(
    `UPDATE platform_settings SET updated_at = now() - make_interval(mins => $1) WHERE setting_key = 'mail_ban_backfill_last'`, [minutes],
  );

  it('the first claim wins; the same lifetime is not due again within the hour — on any replica', async () => {
    expect(await claimBanBackfillSlot(db, 24 * H)).toBe(true);
    expect(await claimBanBackfillSlot(db, 24 * H)).toBe(false);
    await age(59);
    expect(await claimBanBackfillSlot(db, 24 * H)).toBe(false);
  });

  it('is due again after an hour', async () => {
    await claimBanBackfillSlot(db, 24 * H);
    await age(61);
    expect(await claimBanBackfillSlot(db, 24 * H)).toBe(true);
  });

  it('is due at once when the lifetime changes', async () => {
    await claimBanBackfillSlot(db, 24 * H);
    expect(await claimBanBackfillSlot(db, 6 * H)).toBe(true);
    expect(await claimBanBackfillSlot(db, 6 * H)).toBe(false);
  });

  it('of concurrent claims (three replicas + a save) exactly one wins', async () => {
    const wins = await Promise.all(Array.from({ length: 6 }, () => claimBanBackfillSlot(db, 24 * H)));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it('a released claim (failed run) is due on the next tick', async () => {
    await claimBanBackfillSlot(db, 24 * H);
    await releaseBanBackfillSlot(db);
    expect(await claimBanBackfillSlot(db, 24 * H)).toBe(true);
  });
});

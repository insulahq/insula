/**
 * The shared "existing bans were checked" stamp for backfillBanLifetimes.
 *
 * The platform API runs up to three replicas, each restarts on every deploy,
 * and both the 5-minute tick and a save can trigger the check — so "when did
 * it last run, and for which lifetime" cannot live in process memory (every
 * replica would list every ban after each restart). It is one platform_settings
 * row instead: the value is the lifetime in ms, `updated_at` the database
 * clock's time of the last claim.
 *
 * A claim is one atomic statement: it succeeds (and stamps the row) only when
 * the row is absent, holds another lifetime, or is at least an hour old, so of
 * any number of concurrent callers exactly one gets the run.
 */
import { sql, type SQL } from 'drizzle-orm';

/** platform_settings key of the stamp. */
export const BAN_BACKFILL_SLOT_KEY = 'mail_ban_backfill_last';

/**
 * Between lifetime changes only a restored store can bring back bans without
 * an expiry, so an hourly sweep is enough and spares listing every ban on
 * every tick.
 */
export const BAN_BACKFILL_INTERVAL_MINUTES = 60;

interface ExecDb {
  execute(query: SQL): Promise<unknown>;
}

const rowCount = (res: unknown): number => {
  const r = res as { rows?: unknown[]; rowCount?: number | null } | unknown[];
  if (Array.isArray(r)) return r.length;
  return r.rows?.length ?? r.rowCount ?? 0;
};

/** True when this caller should run the backfill for `periodMs` now. */
export async function claimBanBackfillSlot(db: ExecDb, periodMs: number): Promise<boolean> {
  const res = await db.execute(sql`
    INSERT INTO platform_settings (setting_key, setting_value, updated_at)
    VALUES (${BAN_BACKFILL_SLOT_KEY}, ${String(periodMs)}, NOW())
    ON CONFLICT (setting_key) DO UPDATE
      SET setting_value = EXCLUDED.setting_value, updated_at = NOW()
      WHERE platform_settings.setting_value IS DISTINCT FROM EXCLUDED.setting_value
         OR platform_settings.updated_at <= NOW() - make_interval(mins => ${BAN_BACKFILL_INTERVAL_MINUTES})
    RETURNING setting_key
  `);
  return rowCount(res) > 0;
}

/** Give a claim back after a failed run, so the next tick retries instead of waiting an hour. */
export async function releaseBanBackfillSlot(db: ExecDb): Promise<void> {
  await db.execute(sql`DELETE FROM platform_settings WHERE setting_key = ${BAN_BACKFILL_SLOT_KEY}`);
}

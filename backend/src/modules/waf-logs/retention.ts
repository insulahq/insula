/**
 * How long WAF events are kept, and the prune that enforces it.
 *
 * waf_logs used to be capped at the newest 50 rows per route (500 for all
 * platform hosts together), trimmed on every 30-second scrape. A route in
 * detection-only mode — the dry run before enforcing — kept its last minutes:
 * one Moodle site logged 736 would-block requests in a day and showed 50 rows.
 * The cap also starved CrowdSec auto-ban, which judges only rows at least 70 s
 * old: a flood on one route had its older rows deleted before they were judged.
 *
 * Now:
 *  - rows older than the retention (platform setting, default 30 days) go;
 *  - a route over ROUTE_CEILING rows, or the platform hosts over
 *    ADMIN_HOST_CEILING, lose their oldest rows — a flood valve, not the
 *    retention. It never removes a row younger than PROTECTED_RECENT_SECONDS,
 *    so auto-ban always sees a flood whole.
 * Deletes run in batches so a large backlog never holds one long lock.
 */
import { eq, sql, type SQL } from 'drizzle-orm';
import {
  WAF_LOG_RETENTION_DAYS_DEFAULT,
  WAF_LOG_RETENTION_DAYS_MAX,
  WAF_LOG_RETENTION_DAYS_MIN,
  type WafLogSettings,
} from '@insula/api-contracts';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { platformSettings, wafLogs } from '../../db/schema.js';
import { loadConfig as loadAutobanConfig } from '../crowdsec-autoban/scheduler.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = NodePgDatabase<any>;

export const RETENTION_SETTING_KEY = 'security.waf.events_retention_days';
export const ROUTE_CEILING = 20_000;
export const ADMIN_HOST_CEILING = 50_000;
/**
 * The least a flood keeps whole. The real figure also follows auto-ban's own
 * lookback (its configurable window), see protectedRecentSeconds.
 */
export const PROTECTED_RECENT_SECONDS = 15 * 60;
/** Added to auto-ban's window: its 70 s settle time and a tick or two of slack. */
const AUTOBAN_MARGIN_SECONDS = 10 * 60;
/** How often the scraper's leased loop runs the prune. */
export const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
export const BATCH = 5_000;
/** Bounds one step of a run; the next run continues a larger backlog. */
const MAX_BATCHES_PER_STEP = 40;
/** And one run as a whole, so a backlog (retention lowered from 365 days to 1) is worked off over several runs. */
const RUN_BUDGET_MS = 60_000;

/** The stored setting, or the default when unset or unreadable as a number in range. */
export async function loadRetentionDays(db: Db): Promise<number> {
  const [row] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, RETENTION_SETTING_KEY))
    .limit(1);
  const days = Number(row?.value);
  return Number.isInteger(days) && days >= WAF_LOG_RETENTION_DAYS_MIN && days <= WAF_LOG_RETENTION_DAYS_MAX
    ? days
    : WAF_LOG_RETENTION_DAYS_DEFAULT;
}

export async function saveRetentionDays(db: Db, days: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO platform_settings (setting_key, setting_value, updated_at)
    VALUES (${RETENTION_SETTING_KEY}, ${String(days)}, NOW())
    ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()
  `);
}

/**
 * How young a row must be for the ceiling to leave it: auto-ban reads back its
 * window (300 s by default, operator-configurable) and judges rows only once
 * they have settled, so this must outlast that, whatever the window is set to.
 */
export async function protectedRecentSeconds(db: Db): Promise<number> {
  const windowSeconds = await loadAutobanConfig(db).then((c) => c.windowSeconds).catch(() => 300);
  return Math.max(PROTECTED_RECENT_SECONDS, windowSeconds + AUTOBAN_MARGIN_SECONDS);
}

export async function loadWafLogSettings(db: Db): Promise<WafLogSettings> {
  const retentionDays = await loadRetentionDays(db);
  const [stats] = await db
    .select({ stored: sql<number>`count(*)::int`, oldest: sql<Date | string | null>`min(${wafLogs.createdAt})` })
    .from(wafLogs);
  const oldest = stats?.oldest ? new Date(stats.oldest) : null;
  return {
    retentionDays,
    routeCeiling: ROUTE_CEILING,
    adminHostCeiling: ADMIN_HOST_CEILING,
    protectedRecentMinutes: Math.ceil((await protectedRecentSeconds(db)) / 60),
    storedEvents: Number(stats?.stored ?? 0),
    oldestEventAt: oldest ? oldest.toISOString() : null,
  };
}

export interface PruneResult {
  readonly aged: number;
  readonly overCeiling: number;
}

/** Delete in batches the rows `where` selects, until none are left, the step's cap or the run's deadline. */
async function deleteInBatches(db: Db, where: SQL, deadline: number): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES_PER_STEP && Date.now() < deadline; i += 1) {
    const res = await db.execute(sql`
      DELETE FROM waf_logs WHERE id IN (SELECT id FROM waf_logs WHERE ${where} LIMIT ${BATCH})
    `);
    const n = Number((res as unknown as { rowCount?: number }).rowCount ?? 0);
    total += n;
    if (n < BATCH) break;
  }
  return total;
}

/**
 * Cutoffs are computed in SQL from now(), not passed as JS Dates: a Date bound
 * into raw SQL is sent in the API process's local time and read as a
 * `timestamp without time zone`, so it is right only while the pod runs in UTC.
 * `shiftSeconds` moves "now" forward — for tests of time passing.
 */
export async function pruneWafLogs(db: Db, opts: { shiftSeconds?: number } = {}): Promise<PruneResult> {
  const deadline = Date.now() + RUN_BUDGET_MS;
  const now = sql`(now() + make_interval(secs => ${opts.shiftSeconds ?? 0}))`;
  const days = await loadRetentionDays(db);
  const aged = await deleteInBatches(db, sql`created_at < ${now} - make_interval(days => ${days})`, deadline);

  const protectSeconds = await protectedRecentSeconds(db);
  const overRoutes = (await db.execute(sql`
    SELECT route_id FROM waf_logs WHERE route_id IS NOT NULL GROUP BY route_id HAVING count(*) > ${ROUTE_CEILING}
  `) as unknown as { rows: Array<{ route_id: string }> }).rows;
  const buckets: Array<{ where: SQL; ceiling: number }> = [
    ...overRoutes.map((r) => ({ where: sql`route_id = ${r.route_id}`, ceiling: ROUTE_CEILING })),
    { where: sql`route_id IS NULL`, ceiling: ADMIN_HOST_CEILING },
  ];
  let overCeiling = 0;
  for (const b of buckets) {
    // The bucket's (ceiling+1)-th newest row and everything older, found in SQL
    // so the cutoff keeps Postgres' microseconds (a JS Date would round it and
    // spare the cutoff row). Re-evaluated per batch, so it stays right as rows go.
    // Never rows auto-ban still has to judge, even if that leaves the bucket
    // over its ceiling for a while.
    overCeiling += await deleteInBatches(db, sql`${b.where}
      AND created_at < ${now} - make_interval(secs => ${protectSeconds})
      AND created_at <= (SELECT created_at FROM waf_logs WHERE ${b.where} ORDER BY created_at DESC OFFSET ${b.ceiling} LIMIT 1)`, deadline);
  }
  return { aged, overCeiling };
}

/**
 * The prune as the scraper's leased loop runs it: at most every
 * PRUNE_INTERVAL_MS, never two at once, and without holding up the scrape —
 * a cycle that waited for a long prune would start late and its 35 s log
 * window would miss events. Errors are reported, not thrown.
 */
export function createWafLogPruner(
  db: Db,
  log: Pick<Console, 'log' | 'warn'> = console,
  prune: typeof pruneWafLogs = pruneWafLogs,
): { tick: () => Promise<void> | null } {
  let lastStartedAt = 0;
  let running: Promise<void> | null = null;
  return {
    /** Starts a prune when one is due and none is running; returns it (for tests), else null. */
    tick() {
      if (running || Date.now() - lastStartedAt < PRUNE_INTERVAL_MS) return null;
      lastStartedAt = Date.now();
      running = prune(db)
        .then((r) => {
          if (r.aged + r.overCeiling > 0) log.log(`[waf-log-scraper] pruned aged=${r.aged} over-ceiling=${r.overCeiling}`);
        })
        .catch((err: unknown) => {
          log.warn('[waf-log-scraper] prune failed:', err instanceof Error ? err.message : String(err));
        })
        .finally(() => { running = null; });
      return running;
    },
  };
}

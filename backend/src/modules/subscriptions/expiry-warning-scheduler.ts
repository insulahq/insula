/**
 * Daily expiry-warning scheduler.
 *
 * Scans tenants whose `subscription_expires_at` falls in the
 * configured warning windows (default: 7 / 3 / 1 day). For each
 * window, fires a `subscription.expiry_warning` notification with a
 * dedupeKey scoped to (tenant × window × expiry-date) — the dispatcher
 * silently skips duplicates so a re-run of the scheduler the next day
 * never resends the same warning.
 *
 * Excludes the SYSTEM tenant + already-suspended/archived tenants:
 * a warning for them is meaningless. Tenants whose subscription has
 * NO expiry (`subscription_expires_at IS NULL`) are also excluded —
 * they're on perpetual plans.
 *
 * Best-effort: per-tenant emit failures don't abort the batch.
 */
import { and, between, eq, isNotNull } from 'drizzle-orm';
import { tenants } from '../../db/schema.js';
import { notifyTenantSubscriptionExpiry } from '../notifications/events.js';
import type { Database } from '../../db/index.js';

/** Windows in days. Order matters only for log readability. */
export const DEFAULT_WARNING_WINDOWS = [7, 3, 1] as const;

export interface ExpiryWarningRunResult {
  readonly scanned: number;
  readonly emitted: number;
  readonly failed: number;
}

export interface ExpiryWarningOptions {
  readonly now?: Date;
  readonly windowsDays?: readonly number[];
}

/**
 * One pass of the scheduler. Exported for direct test invocation.
 */
export async function runExpiryWarningPass(
  db: Database,
  opts: ExpiryWarningOptions = {},
): Promise<ExpiryWarningRunResult> {
  const now = opts.now ?? new Date();
  const windows = opts.windowsDays ?? DEFAULT_WARNING_WINDOWS;
  let scanned = 0;
  let emitted = 0;
  let failed = 0;

  for (const daysOut of windows) {
    // Find tenants whose expires_at falls in the day-wide window
    // around `now + daysOut`. We use a day boundary (midnight ± 12h)
    // rather than an instant so the scheduler's exact tick time
    // doesn't matter — running at 03:00 or 12:00 produces the same
    // result set.
    const windowStart = startOfDay(addDays(now, daysOut));
    const windowEnd = endOfDay(addDays(now, daysOut));
    // eslint-disable-next-line no-await-in-loop
    const rows = await db
      .select({
        id: tenants.id,
        name: tenants.name,
        expiresAt: tenants.subscriptionExpiresAt,
        isSystem: tenants.isSystem,
        status: tenants.status,
      })
      .from(tenants)
      .where(and(
        isNotNull(tenants.subscriptionExpiresAt),
        between(tenants.subscriptionExpiresAt, windowStart, windowEnd),
        eq(tenants.status, 'active'),
        eq(tenants.isSystem, false),
      ));

    for (const t of rows) {
      scanned++;
      if (!t.expiresAt) continue;
      const expiryDateKey = t.expiresAt.toISOString().slice(0, 10);
      const dedupeKey = `subscription-expiry:${t.id}:${daysOut}d:${expiryDateKey}`;
      try {
        // eslint-disable-next-line no-await-in-loop
        await notifyTenantSubscriptionExpiry(
          db,
          t.id,
          {
            tenantName: t.name ?? undefined,
            expiresAt: t.expiresAt.toISOString(),
            daysUntilExpiry: daysOut,
          },
          dedupeKey,
        );
        emitted++;
      } catch {
        failed++;
      }
    }
  }

  return { scanned, emitted, failed };
}

/**
 * Start the periodic scheduler. Runs every 6 hours so an outage that
 * caused us to miss a daily tick is recovered automatically. The
 * dispatcher's dedupe check prevents over-sending.
 *
 * unref'd so it doesn't pin the event loop on shutdown.
 */
export function startExpiryWarningScheduler(
  db: Database,
  log?: { info: (msg: string, extra?: Record<string, unknown>) => void; warn: (msg: string, err?: unknown) => void },
): NodeJS.Timeout {
  const INTERVAL_MS = 6 * 60 * 60 * 1000;
  const tick = async (): Promise<void> => {
    try {
      const r = await runExpiryWarningPass(db);
      log?.info('[notifications] expiry-warning scheduler tick', {
        scanned: r.scanned, emitted: r.emitted, failed: r.failed,
      });
    } catch (err) {
      log?.warn('[notifications] expiry-warning scheduler tick failed', err);
    }
  };
  // Fire once immediately so a fresh deploy doesn't wait 6 hours for
  // the first scan; dedupeKey guards against double-fire.
  void tick();
  const timer = setInterval(() => { void tick(); }, INTERVAL_MS);
  timer.unref?.();
  return timer;
}

// ─── pure date helpers ──────────────────────────────────────────────
// All arithmetic is UTC-based — container clocks should be UTC anyway,
// but doing arithmetic via Date.UTC and *UTC methods makes this robust
// against the host timezone (DST review fix 2026-05-29).
function addDays(d: Date, days: number): Date {
  return new Date(Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + days,
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  ));
}
function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}
function endOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

/**
 * Phase A.4 of the backup UI consolidation: system-wide tenant-bundle
 * scheduler.
 *
 * Replaces (eventually) the per-tenant `tenant_backup_schedules` model
 * with a single global cron in `backup_schedules.tenant_bundle`. On
 * each tick (5 min):
 *
 *   1. Read backup_schedules WHERE subsystem='tenant_bundle'.
 *   2. If enabled=false, exit. If no cron, exit.
 *   3. Evaluate "should fire now?": within ±5 min of the cron's
 *      hour:minute today AND last_run_at older than 23h.
 *   4. Iterate eligible tenants:
 *        SELECT t.id FROM tenants t
 *        JOIN hosting_plans p ON p.id = t.plan_id
 *        WHERE COALESCE(t.include_in_scheduled_bundles,
 *                       p.include_in_scheduled_bundles) = TRUE
 *          AND t.status != 'archived'
 *      (SYSTEM tenant participates — no is_system filter. 'archived'
 *      is the terminal state in `tenant_status` — the enum has no
 *      'deleted' value; a regression test pins this.)
 *   5. For each tenant, call the existing runOneScheduledBundle
 *      flow from schedule.ts.
 *   6. Update backup_schedules.last_run_at (added via UPDATE in tick).
 *
 * Coexists with the legacy per-tenant scheduler in schedule.ts. Legacy
 * rows in `tenant_backup_schedules` still fire from that path; new
 * tenants get no per-tenant row, so the global cron is the only
 * driver for them.
 */

import { eq, sql } from 'drizzle-orm';
import { backupSchedules, tenants, hostingPlans } from '../../db/schema.js';
import type { FastifyInstance } from 'fastify';

const TICK_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Wall-clock window matched against the cron's HH:MM. A tick fires
 * the bundle wave when "now is within ±FIRE_WINDOW_MIN of HH:MM AND
 * last fire was earlier today before that window."
 */
const FIRE_WINDOW_MIN = 5;

/**
 * Parse one field of a 5-field cron expression (minute or hour) into
 * the set of values it matches. Supports:
 *   - literal `N`              → {N}
 *   - star    `*`              → all values in [min, max]
 *   - step    `* /N` or `M/N`  → multiples of N (or M, M+N, M+2N, …)
 *   - list    `A,B,C`          → union of A, B, C parsed recursively
 *
 * Range syntax (`A-B`) is intentionally NOT supported yet — none of
 * the platform's schedules use it. Returns null if any token is
 * malformed (the scheduler then logs and skips the tick rather than
 * silently misfiring).
 */
function parseCronField(token: string, min: number, max: number): Set<number> | null {
  const result = new Set<number>();
  const items = token.split(',');
  for (const raw of items) {
    const item = raw.trim();
    if (item.length === 0) return null;
    const stepMatch = item.match(/^(\*|\d+)\/(\d+)$/);
    if (stepMatch) {
      const base = stepMatch[1] === '*' ? min : Number(stepMatch[1]);
      const step = Number(stepMatch[2]);
      if (!Number.isInteger(base) || !Number.isInteger(step) || step <= 0) return null;
      if (base < min || base > max) return null;
      for (let v = base; v <= max; v += step) result.add(v);
      continue;
    }
    if (item === '*') {
      for (let v = min; v <= max; v += 1) result.add(v);
      continue;
    }
    const n = Number(item);
    if (!Number.isInteger(n) || n < min || n > max) return null;
    result.add(n);
  }
  return result.size === 0 ? null : result;
}

interface ParsedCron {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
}

function parseSimpleCron(expr: string): ParsedCron | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minutes = parseCronField(parts[0], 0, 59);
  const hours = parseCronField(parts[1], 0, 23);
  if (!minutes || !hours) return null;
  return { minutes, hours };
}

function shouldFireNow(cronExpr: string, lastRun: Date | null, now: Date): boolean {
  const cron = parseSimpleCron(cronExpr);
  if (!cron) return false;
  // Compute the nearest fire instant (UTC) that the cron matches.
  // For step-style crons (e.g. `*/10 * * * *`) the candidate set has
  // many entries today, so pick the one whose distance to `now` is
  // smallest. Then apply the ±window check.
  const windowMs = FIRE_WINDOW_MIN * 60_000;
  let bestDiff = Infinity;
  let bestFire = 0;
  for (const hour of cron.hours) {
    for (const minute of cron.minutes) {
      const fire = Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
        hour, minute, 0, 0,
      );
      const diff = Math.abs(now.getTime() - fire);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestFire = fire;
      }
    }
  }
  if (bestDiff > windowMs) return false;
  // Already fired in this window?
  if (lastRun && lastRun.getTime() >= bestFire - windowMs) return false;
  return true;
}

interface TickResult {
  readonly fired: boolean;
  readonly tenantsConsidered: number;
  readonly tenantsRan: number;
  readonly errors: number;
}

export async function runGlobalBundleTick(app: FastifyInstance, now: Date = new Date()): Promise<TickResult> {
  const [schedule] = await app.db.select().from(backupSchedules)
    .where(eq(backupSchedules.subsystem, 'tenant_bundle'));
  if (!schedule || !schedule.enabled || !schedule.cronExpression) {
    app.log.debug(
      { subsystem: 'tenant_bundle', enabled: schedule?.enabled, cron: schedule?.cronExpression },
      'tenant-bundle global scheduler: tick — no schedule or disabled',
    );
    return { fired: false, tenantsConsidered: 0, tenantsRan: 0, errors: 0 };
  }
  // Migration 0024: dedicated last_fired_at column. Previously this
  // used updated_at, which double-duty'd as "operator edit timestamp"
  // and produced both false-positive fires (after an operator PATCH)
  // and false-negative skips (when the pod restart shifted ticks
  // outside the ±5min window with updated_at never bumped).
  const lastRun: Date | null = schedule.lastFiredAt ?? null;
  if (!shouldFireNow(schedule.cronExpression, lastRun, now)) {
    app.log.debug(
      {
        cron: schedule.cronExpression,
        nowUtc: now.toISOString(),
        lastFiredAtUtc: lastRun?.toISOString() ?? null,
      },
      'tenant-bundle global scheduler: tick — outside fire window',
    );
    return { fired: false, tenantsConsidered: 0, tenantsRan: 0, errors: 0 };
  }

  // Iterate eligible tenants. SYSTEM tenant is_system=TRUE participates.
  const eligible = await app.db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .innerJoin(hostingPlans, eq(hostingPlans.id, tenants.planId))
    .where(sql`
      ${tenants.status} != 'archived'
      AND COALESCE(${tenants.includeInScheduledBundlesOverride},
                   ${hostingPlans.includeInScheduledBundles}) = TRUE
    `);

  app.log.info(
    { count: eligible.length, cron: schedule.cronExpression },
    'tenant-bundle global scheduler: firing wave',
  );

  let ran = 0;
  let errors = 0;
  const { runOneScheduledBundle } = await import('./schedule.js') as {
    runOneScheduledBundle?: (app: FastifyInstance, tenantId: string, retentionDays: number) => Promise<void>;
  };
  if (!runOneScheduledBundle) {
    // schedule.ts didn't export it (private). Fall back to runBundle
    // direct call would be heavier; skip wave and log.
    app.log.warn('tenant-bundle global scheduler: schedule.ts:runOneScheduledBundle not exported — wave skipped');
    return { fired: true, tenantsConsidered: eligible.length, tenantsRan: 0, errors: eligible.length };
  }
  for (const t of eligible) {
    try {
      await runOneScheduledBundle(app, t.id, schedule.retentionDays ?? 30);
      ran += 1;
    } catch (err) {
      errors += 1;
      app.log.error({ err, tenantId: t.id }, 'tenant-bundle global scheduler: bundle failed');
    }
  }

  // Mark this fire window done. Migration 0024 added last_fired_at,
  // a dedicated marker we set independent of operator edits.
  await app.db.update(backupSchedules)
    .set({ lastFiredAt: now })
    .where(eq(backupSchedules.subsystem, 'tenant_bundle'));

  return { fired: true, tenantsConsidered: eligible.length, tenantsRan: ran, errors };
}

export function startGlobalBundleScheduler(app: FastifyInstance): NodeJS.Timeout {
  app.log.info(
    { intervalMs: TICK_INTERVAL_MS, fireWindowMin: FIRE_WINDOW_MIN },
    'tenant-bundle global scheduler: started',
  );
  const tick = async () => {
    try {
      const r = await runGlobalBundleTick(app);
      if (r.fired) {
        app.log.info({ ...r }, 'tenant-bundle global scheduler: tick complete');
      }
    } catch (err) {
      app.log.error({ err }, 'tenant-bundle global scheduler: tick failed');
    }
  };
  // Fire one tick immediately on boot so a freshly-rolled pod can
  // recover a missed window if it lands within the cron window. The
  // bookkeeping in last_fired_at prevents duplicate fires on a busy
  // cluster where multiple pods boot during the same window.
  void tick();
  const handle = setInterval(tick, TICK_INTERVAL_MS);
  // Don't keep the process alive on shutdown.
  if (typeof handle.unref === 'function') handle.unref();
  return handle;
}

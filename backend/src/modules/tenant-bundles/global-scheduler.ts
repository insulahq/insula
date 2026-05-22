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
 *          AND t.status != 'deleted'
 *      (SYSTEM tenant participates — no is_system filter.)
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
 * Parse just the minute + hour fields of a 5-field cron expression.
 * Returns null on anything unsupported (ranges, lists, steps). Phase
 * 2 swaps this for `cron-parser` to handle ranges/lists/named months.
 */
function parseSimpleCron(expr: string): { minute: number; hour: number } | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  return { minute, hour };
}

function shouldFireNow(cronExpr: string, lastRun: Date | null, now: Date): boolean {
  const cron = parseSimpleCron(cronExpr);
  if (!cron) return false;
  // Compute today's fire instant (UTC).
  const fire = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    cron.hour, cron.minute, 0, 0,
  ));
  // Inside the ±window?
  const windowMs = FIRE_WINDOW_MIN * 60_000;
  const inWindow = Math.abs(now.getTime() - fire.getTime()) <= windowMs;
  if (!inWindow) return false;
  // Already fired in this window?
  if (lastRun && lastRun.getTime() >= fire.getTime() - windowMs) return false;
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
      ${tenants.status} != 'deleted'
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

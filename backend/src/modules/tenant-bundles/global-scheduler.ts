/**
 * System-wide tenant-bundle scheduler.
 *
 * Single global cron in `backup_schedules.tenant_bundle`. On each tick
 * (5 min):
 *
 *   1. Read backup_schedules WHERE subsystem='tenant_bundle'.
 *   2. If enabled=false, exit. If no cron, exit.
 *   3. Evaluate "should fire now?": some minute in the last
 *      FIRE_WINDOW_MIN minutes matches the FULL 5-field cron
 *      (shared/cron-match.ts — same matcher the mail engine uses, so
 *      ranges and DOM/DOW restrictions behave identically everywhere).
 *   4. CLAIM the fire with a replica-safe conditional UPDATE on
 *      last_fired_at (HA mode runs 2-3 platform-api replicas — without
 *      the claim every replica fires the whole fleet).
 *   5. Iterate eligible tenants:
 *        SELECT t.id FROM tenants t
 *        JOIN hosting_plans p ON p.id = t.plan_id
 *        WHERE COALESCE(t.include_in_scheduled_bundles,
 *                       p.include_in_scheduled_bundles) = TRUE
 *          AND t.status != 'archived'
 *      (SYSTEM tenant participates — no is_system filter. 'archived'
 *      is the terminal state in `tenant_status` — the enum has no
 *      'deleted' value; a regression test pins this.)
 *   6. For each tenant, call runOneScheduledBundle from schedule.ts.
 *   7. Per-tenant failures are counted AND surfaced as an
 *      admin.backup_failed notification — a wave that fails for every
 *      tenant must never be silent (2026-08-26: a CIFS target made all
 *      scheduled bundles throw for two nights with only pod-local log
 *      lines as evidence).
 */

import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { backupSchedules, tenants, hostingPlans } from '../../db/schema.js';
import { cronMatchesMinute } from '../../shared/cron-match.js';
import { notifyAdminBackupFailed } from '../notifications/events.js';
import type { FastifyInstance } from 'fastify';

const TICK_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Lookback window (minutes) matched against the cron. A tick fires the
 * bundle wave when some minute in [now - window, now] matches the cron
 * AND that minute hasn't been claimed yet. Must be >= the tick
 * interval or a fire minute can fall between two ticks.
 */
const FIRE_WINDOW_MIN = 5;

/**
 * Most recent minute within the lookback window that matches the cron,
 * or null. Full 5-field semantics via shared/cron-match.ts — a weekly
 * cron (`0 3 * * 0`) only matches on Sundays, and `A-B` ranges work.
 */
function latestMatchingMinute(cronExpr: string, now: Date): Date | null {
  const floorMinute = Math.floor(now.getTime() / 60_000) * 60_000;
  for (let back = 0; back <= FIRE_WINDOW_MIN; back++) {
    const cand = new Date(floorMinute - back * 60_000);
    if (cronMatchesMinute(cronExpr, cand)) return cand;
  }
  return null;
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
  const fireAt = latestMatchingMinute(schedule.cronExpression, now);
  if (!fireAt) {
    app.log.debug(
      {
        cron: schedule.cronExpression,
        nowUtc: now.toISOString(),
        lastFiredAtUtc: schedule.lastFiredAt?.toISOString() ?? null,
      },
      'tenant-bundle global scheduler: tick — outside fire window',
    );
    return { fired: false, tenantsConsidered: 0, tenantsRan: 0, errors: 0 };
  }

  // Replica-safe claim (mirrors the mail firing engine): only the
  // replica whose conditional UPDATE lands runs the wave. Claiming
  // BEFORE the wave also means a crash mid-wave skips to the next
  // cron window instead of re-bundling the whole fleet.
  const claimed = await app.db
    .update(backupSchedules)
    .set({ lastFiredAt: fireAt })
    .where(and(
      eq(backupSchedules.subsystem, 'tenant_bundle'),
      or(isNull(backupSchedules.lastFiredAt), lt(backupSchedules.lastFiredAt, fireAt)),
    ))
    .returning({ subsystem: backupSchedules.subsystem });
  if (claimed.length === 0) {
    app.log.debug(
      { fireAt: fireAt.toISOString() },
      'tenant-bundle global scheduler: fire window already claimed (another replica or earlier tick)',
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
    { count: eligible.length, cron: schedule.cronExpression, fireAt: fireAt.toISOString() },
    'tenant-bundle global scheduler: firing wave',
  );

  let ran = 0;
  let errors = 0;
  let firstError: string | null = null;
  const { runOneScheduledBundle } = await import('./schedule.js') as {
    runOneScheduledBundle?: (app: FastifyInstance, tenantId: string, retentionDays: number) => Promise<void>;
  };
  if (!runOneScheduledBundle) {
    app.log.warn('tenant-bundle global scheduler: schedule.ts:runOneScheduledBundle not exported — wave skipped');
    errors = eligible.length;
    firstError = 'runOneScheduledBundle not exported';
  } else {
    for (const t of eligible) {
      try {
        await runOneScheduledBundle(app, t.id, schedule.retentionDays ?? 30);
        ran += 1;
      } catch (err) {
        errors += 1;
        if (!firstError) firstError = err instanceof Error ? err.message : String(err);
        app.log.error({ err, tenantId: t.id }, 'tenant-bundle global scheduler: bundle failed');
      }
    }
  }

  if (errors > 0) {
    // One notification per fire window (dedupeKey = the fire minute) so
    // an all-tenants failure is visible in the admin panel + email, not
    // only in pod-local logs that die with the pod.
    try {
      await notifyAdminBackupFailed(app.db, {
        backupName: 'Scheduled tenant bundles',
        errorMessage: `${errors}/${eligible.length} tenants failed (first error: ${firstError ?? 'unknown'})`,
      }, `tenant-bundle-wave:${fireAt.toISOString()}`);
    } catch (err) {
      app.log.error({ err }, 'tenant-bundle global scheduler: failure notification dispatch failed');
    }
  }

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
  // conditional claim on last_fired_at prevents duplicate fires when
  // multiple pods boot during the same window.
  void tick();
  const handle = setInterval(tick, TICK_INTERVAL_MS);
  // Don't keep the process alive on shutdown.
  if (typeof handle.unref === 'function') handle.unref();
  return handle;
}

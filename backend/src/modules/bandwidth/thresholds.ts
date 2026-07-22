/**
 * Monthly-bandwidth threshold evaluation (BW-3) + cap trigger (BW-4 hook).
 *
 * Runs each meter tick after accumulation. For every provisioned tenant it
 * compares month-to-date `bandwidth_gb_used` against the effective limit and,
 * at the highest newly-crossed threshold (80 / 90 / 100%), alerts BOTH the
 * admin and the tenant. At 100% it flips `bandwidth_capped` (which the ingress
 * reconciler turns into a 509 — BW-4). Dedupe is the dispatcher's per
 * (recipient, dedupeKey); the key includes the threshold + month, so each
 * threshold alerts at most once per billing month.
 */

import { eq } from 'drizzle-orm';
import { tenants, hostingPlans } from '../../db/schema.js';
import { resolveBandwidthLimit } from './limit.js';
import type { Database } from '../../db/index.js';

export const BANDWIDTH_THRESHOLDS = [80, 90, 100] as const;
export type BandwidthThreshold = (typeof BANDWIDTH_THRESHOLDS)[number];

export interface BwLogger {
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
}

/** Highest crossed threshold, or null when under 80% (or no limit). */
export function bandwidthThreshold(usedGb: number, limitGb: number): BandwidthThreshold | null {
  if (!(limitGb > 0)) return null;
  const pct = (usedGb / limitGb) * 100;
  let hit: BandwidthThreshold | null = null;
  for (const t of BANDWIDTH_THRESHOLDS) if (pct >= t) hit = t;
  return hit;
}

/**
 * Evaluate all tenants; returns how many fired an alert this pass. Also flips
 * `bandwidth_capped` at 100% (enforced by the ingress reconciler). Never throws.
 */
export async function evaluateBandwidthThresholds(db: Database, logger: BwLogger = {}): Promise<number> {
  const rows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      used: tenants.bandwidthGbUsed,
      override: tenants.bandwidthLimitOverride,
      planLimit: hostingPlans.bandwidthGbLimit,
      cycleStart: tenants.bandwidthCycleStart,
      capped: tenants.bandwidthCapped,
      provisioningStatus: tenants.provisioningStatus,
    })
    .from(tenants)
    .leftJoin(hostingPlans, eq(tenants.planId, hostingPlans.id));

  const now = new Date();
  let fired = 0;

  for (const t of rows) {
    if (t.provisioningStatus !== 'provisioned') continue;
    const limit = resolveBandwidthLimit(t.override, t.planLimit);
    const used = Number(t.used ?? 0);
    const threshold = bandwidthThreshold(used, limit);
    if (!threshold) continue;

    const level = threshold >= 100 ? 'critical' : 'warning';
    const monthBucket = (t.cycleStart ?? now).toISOString().slice(0, 7); // YYYY-MM
    const usedPct = String(Math.min(999, Math.round((used / limit) * 100)));
    const usedStr = String(Math.round(used * 100) / 100);
    const limitStr = String(limit);

    // At 100%: enable the cap (BW-4's ingress reconciler serves the 509). The
    // meter lifts it at the month rollover. Guard so we stamp cappedAt once.
    if (threshold >= 100 && !t.capped) {
      await db.update(tenants)
        .set({ bandwidthCapped: true, bandwidthCappedAt: now })
        .where(eq(tenants.id, t.id));
    }

    try {
      const { notifyAdminTenantBandwidth, notifyTenantBandwidth } = await import('../notifications/events.js');
      const dedupeKey = `bw:${t.id}:${threshold}:${monthBucket}`;
      await notifyAdminTenantBandwidth(db, level, { tenantLabel: t.name, usedPct, used: usedStr, limit: limitStr }, dedupeKey);
      await notifyTenantBandwidth(db, t.id, level, { usedPct, used: usedStr, limit: limitStr }, dedupeKey);
      fired += 1;
    } catch (err) {
      logger.warn?.({ err, tenantId: t.id }, 'bandwidth thresholds: notification failed');
    }
  }

  if (fired > 0) logger.info?.({ fired }, 'bandwidth thresholds: evaluated');
  return fired;
}

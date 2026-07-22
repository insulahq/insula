/**
 * Per-tenant monthly bandwidth meter (BW-2).
 *
 * Runs hourly. Queries vmsingle for each tenant namespace's transmit-byte
 * DELTA since the last run — `sum by (namespace) (increase(...))` — which lets
 * VictoriaMetrics absorb counter resets and pod churn, so no per-pod
 * bookkeeping is needed. Accumulates the delta into `tenants.bandwidth_gb_used`
 * (a single value per tenant — bounded) and resets it to 0 at the UTC
 * calendar-month boundary, also lifting any bandwidth cap for the new cycle.
 *
 * Footprint: no per-tenant time-series is written here; the month-to-date total
 * lives on the tenant row. (Historical hourly rollup into usage_metrics + its
 * reaper is Phase 2.)
 */

import { eq } from 'drizzle-orm';
import { tenants, platformSettings } from '../../db/schema.js';
import { queryInstant } from '../monitoring/vm-client.js';
import { evaluateBandwidthThresholds } from './thresholds.js';
import type { Database } from '../../db/index.js';

const LAST_RUN_KEY = 'bandwidth_meter_last_run';
const MIN_GAP_S = 60;
const MAX_GAP_S = 2 * 3600; // cap the increase() lookback so a long gap can't over-query
const DEFAULT_GAP_S = 3600;
/** Decimal GB (bandwidth billing convention), not GiB. */
const BYTES_PER_GB = 1_000_000_000;

export interface MeterLogger {
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
}

/** UTC first-of-month 00:00:00 for the given instant. */
export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** True when the stored cycle start is missing or in an earlier UTC month. */
export function isNewCycle(cycleStart: Date | null | undefined, now: Date): boolean {
  if (!cycleStart) return true;
  return cycleStart.getUTCFullYear() !== now.getUTCFullYear()
    || cycleStart.getUTCMonth() !== now.getUTCMonth();
}

export function bytesToGb(bytes: number): number {
  return bytes / BYTES_PER_GB;
}

async function getLastRun(db: Database): Promise<Date | null> {
  const [row] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, LAST_RUN_KEY));
  if (!row?.value) return null;
  const t = new Date(row.value);
  return Number.isNaN(t.getTime()) ? null : t;
}

async function setLastRun(db: Database, at: Date): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key: LAST_RUN_KEY, value: at.toISOString() })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value: at.toISOString() } });
}

/**
 * One metering pass. Returns the number of tenants updated. Never throws by
 * contract — a vmsingle outage just skips the accumulation for this tick (the
 * month-to-date total is preserved; the next successful tick covers the gap via
 * a wider increase() window, bounded by MAX_GAP_S).
 */
export async function meterBandwidthOnce(db: Database, logger: MeterLogger = {}): Promise<number> {
  const now = new Date();
  const lastRun = await getLastRun(db);
  const gapS = lastRun
    ? Math.min(MAX_GAP_S, Math.max(MIN_GAP_S, Math.round((now.getTime() - lastRun.getTime()) / 1000)))
    : DEFAULT_GAP_S;

  // Per-namespace transmit-byte delta for the window. increase() sums each
  // pod/interface series' rise (handling resets), then sum by namespace folds
  // pod churn away. Empty result (no traffic / vmsingle down) → all-zero deltas.
  let byNamespace = new Map<string, number>();
  try {
    const samples = await queryInstant(
      `sum by (namespace) (increase(container_network_transmit_bytes_total{namespace!=""}[${gapS}s]))`,
    );
    byNamespace = new Map(
      samples
        .map((s) => [s.labels.namespace ?? '', s.value] as const)
        .filter(([ns, v]) => ns.length > 0 && Number.isFinite(v) && v >= 0),
    );
  } catch (err) {
    logger.warn?.({ err }, 'bandwidth-meter: vmsingle query failed — skipping accumulation this tick');
    // Still advance lastRun? No — leave it so the next tick's wider window
    // (capped at MAX_GAP_S) recovers the missed bytes.
    return 0;
  }

  const rows = await db
    .select({
      id: tenants.id,
      namespace: tenants.kubernetesNamespace,
      used: tenants.bandwidthGbUsed,
      cycleStart: tenants.bandwidthCycleStart,
      provisioningStatus: tenants.provisioningStatus,
    })
    .from(tenants);

  let updated = 0;
  const cycleAnchor = monthStartUtc(now);

  for (const t of rows) {
    if (t.provisioningStatus !== 'provisioned') continue;
    const rollover = isNewCycle(t.cycleStart, now);
    const priorUsed = rollover ? 0 : Number(t.used ?? 0);
    const deltaGb = bytesToGb(byNamespace.get(t.namespace) ?? 0);
    const newUsed = priorUsed + deltaGb;

    const set: Record<string, unknown> = { bandwidthGbUsed: String(newUsed) };
    if (rollover) {
      // New billing month: reset the counter, anchor the cycle, and lift any
      // cap so the tenant serves again from the first of the month.
      set.bandwidthCycleStart = cycleAnchor;
      set.bandwidthCapped = false;
      set.bandwidthCappedAt = null;
    }
    await db.update(tenants).set(set).where(eq(tenants.id, t.id));
    updated += 1;
  }

  await setLastRun(db, now);
  if (updated > 0) {
    logger.info?.({ updated, gapS }, 'bandwidth-meter: accumulated');
  }
  return updated;
}

/**
 * Start the hourly bandwidth meter. Returns a stop function for onClose. Kicks
 * ~90s after boot (let vmsingle scrape at least once), then hourly.
 */
export function startBandwidthMeter(
  db: Database,
  logger: MeterLogger = {},
  intervalMs = 3_600_000,
): () => void {
  const runOnce = (): void => {
    // Accumulate usage, then evaluate 80/90/100% thresholds (BW-3) + flip the
    // cap flag (BW-4) — independent so a threshold error can't skip metering.
    meterBandwidthOnce(db, logger)
      .then(() => evaluateBandwidthThresholds(db, logger))
      .catch((err: unknown) => {
        logger.warn?.({ err }, 'bandwidth-meter: pass failed');
      });
  };
  const bootKick = setTimeout(runOnce, 90_000);
  bootKick.unref?.();
  const timer = setInterval(runOnce, intervalMs);
  timer.unref?.();
  return () => {
    clearTimeout(bootKick);
    clearInterval(timer);
  };
}

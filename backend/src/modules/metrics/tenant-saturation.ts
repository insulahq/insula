/**
 * Per-tenant resource-saturation admin alerting (resource monitoring, 2026-07).
 *
 * Low-footprint by design (the operator's cardinality choice): this evaluates
 * per-tenant CPU/memory/storage usage-vs-limit and fires ADMIN notifications —
 * it publishes NO per-tenant time-series into vmsingle. It runs off the metrics
 * the hourly metrics-scheduler ALREADY collects (metrics-server + file-manager
 * du), so it adds no extra metrics-server load and no storage.
 *
 * Dedupe is the dispatcher's (admin recipient, dedupeKey); the hour-bucket key
 * re-fires at most once per (tenant, resource, level) per hour while sustained.
 */

import type { Database } from '../../db/index.js';
import type { ResourceMetrics } from './resource-metrics.js';

/** CPU/memory: warn at 90% of allocation, critical at/over 100% (throttle/OOM). */
export const SATURATION_WARN = 0.9;
export const SATURATION_CRITICAL = 1.0;
/** Storage can't cleanly reach 100% (fs reserve), so critical is 95%. */
export const STORAGE_SATURATION_CRITICAL = 0.95;

/** Pure: usage ratio + thresholds → severity. */
export function saturationLevel(ratio: number, warn: number, crit: number): 'critical' | 'warning' | null {
  if (!Number.isFinite(ratio) || ratio < warn) return null;
  return ratio >= crit ? 'critical' : 'warning';
}

interface SatLogger { warn?(...args: unknown[]): void }

interface Dimension {
  readonly resource: 'CPU' | 'memory' | 'storage';
  readonly unit: string;
  readonly inUse: number;
  readonly available: number;
  readonly crit: number;
}

/**
 * Evaluate one tenant's freshly-collected metrics and fire admin saturation
 * alerts. Returns the number fired. Never throws (per-dimension try/catch).
 */
export async function evaluateTenantSaturation(
  db: Database,
  tenantId: string,
  tenantLabel: string,
  metrics: ResourceMetrics,
  logger?: SatLogger,
): Promise<number> {
  const dims: readonly Dimension[] = [
    { resource: 'CPU', unit: ' cores', inUse: metrics.cpu.inUse, available: metrics.cpu.available, crit: SATURATION_CRITICAL },
    { resource: 'memory', unit: ' GiB', inUse: metrics.memory.inUse, available: metrics.memory.available, crit: SATURATION_CRITICAL },
    { resource: 'storage', unit: ' GiB', inUse: metrics.storage.inUse, available: metrics.storage.available, crit: STORAGE_SATURATION_CRITICAL },
  ];
  const hourBucket = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  let fired = 0;

  for (const d of dims) {
    if (d.available <= 0) continue; // unlimited / limit unknown — nothing to saturate
    const ratio = d.inUse / d.available;
    const level = saturationLevel(ratio, SATURATION_WARN, d.crit);
    if (!level) continue;
    try {
      const { notifyAdminTenantResourceSaturation } = await import('../notifications/events.js');
      await notifyAdminTenantResourceSaturation(
        db,
        level,
        {
          tenantLabel,
          resource: d.resource,
          usedPct: String(Math.round(ratio * 100)),
          used: String(Math.round(d.inUse * 100) / 100),
          limit: String(d.available),
          unit: d.unit,
        },
        `sat:${tenantId}:${d.resource}:${level}:${hourBucket}`,
      );
      fired += 1;
    } catch (err) {
      logger?.warn?.({ err, tenantId, resource: d.resource }, 'tenant-saturation: notification failed');
    }
  }
  return fired;
}

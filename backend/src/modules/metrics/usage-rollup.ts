/**
 * Phase 2 — historical usage rollup + reaper (resource monitoring, 2026-07).
 *
 * Turns the previously-dead `usage_metrics` table into a bounded time-series:
 *   • WRITER  — one aggregate row per (tenant, metric_type, hour). Called from
 *     the hourly metrics-scheduler (cpu/mem/storage) and the bandwidth meter
 *     (bandwidth). No per-pod series (the operator's cardinality choice).
 *   • REAPER  — a daily job folds hourly rows older than 30d into daily rows
 *     (kept 1y), then purges. This is what keeps growth bounded.
 *
 * Aggregate semantics differ per metric: bandwidth is a per-hour DELTA, so a day
 * is the SUM of its hours (billing-grade); cpu/mem/storage are gauges, so a day
 * keeps the peak (MAX) — the most useful signal for capacity review.
 */

import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { usageMetrics } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

export type UsageMetricType = 'cpu_cores' | 'memory_gb' | 'storage_gb' | 'bandwidth_gb';

/** Per-metric daily-fold aggregate: bandwidth accumulates, gauges keep the peak. */
const DAILY_AGG: Record<UsageMetricType, 'sum' | 'max'> = {
  cpu_cores: 'max',
  memory_gb: 'max',
  storage_gb: 'max',
  bandwidth_gb: 'sum',
};

export const RETAIN_HOURLY_DAYS = 30;
export const RETAIN_DAILY_DAYS = 365;

/** UTC hour bucket (minutes/seconds/ms zeroed) — the hourly row's timestamp. */
export function hourBucketUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 0, 0, 0));
}

/**
 * Reaper cutoffs. `hourlyCutoff` is day-aligned so only COMPLETE days past the
 * 30-day window are folded — never a partial (still-growing) day, which would
 * double-count bandwidth across reap runs.
 */
export function reapCutoffs(now: Date): { hourlyCutoff: Date; dailyCutoff: Date } {
  const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    hourlyCutoff: new Date(todayStartMs - RETAIN_HOURLY_DAYS * 86_400_000),
    dailyCutoff: new Date(now.getTime() - RETAIN_DAILY_DAYS * 86_400_000),
  };
}

/**
 * Upsert one hour's samples for a tenant. Gauges keep the peak within the hour;
 * bandwidth accumulates (SUM) so multiple ticks in one hour don't lose deltas.
 * Never throws — a rollup write must not break the scheduler cycle.
 */
export async function recordHourlyUsage(
  db: Database,
  tenantId: string,
  samples: Partial<Record<UsageMetricType, number>>,
  now: Date = new Date(),
): Promise<void> {
  const bucket = hourBucketUtc(now);
  const entries = (Object.entries(samples) as [UsageMetricType, number | undefined][])
    .filter((e): e is [UsageMetricType, number] => typeof e[1] === 'number' && Number.isFinite(e[1]));
  for (const [metricType, value] of entries) {
    try {
      const accumulate = DAILY_AGG[metricType] === 'sum';
      await db.insert(usageMetrics).values({
        id: crypto.randomUUID(),
        tenantId,
        metricType,
        resolution: 'hourly',
        value: value.toFixed(4),
        measurementTimestamp: bucket,
      }).onConflictDoUpdate({
        target: [
          usageMetrics.tenantId, usageMetrics.metricType,
          usageMetrics.resolution, usageMetrics.measurementTimestamp,
        ],
        set: {
          value: accumulate
            ? sql`${usageMetrics.value} + excluded.value`
            : sql`greatest(${usageMetrics.value}, excluded.value)`,
        },
      });
    } catch (err) {
      console.warn(`[usage-rollup] record failed for ${tenantId}/${metricType}:`, err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * Fold + purge in one transaction:
 *   1. fold complete hourly days older than 30d into daily rows (idempotent —
 *      DO UPDATE replaces with the full-day aggregate),
 *   2. delete those hourly rows,
 *   3. delete daily rows older than 1y.
 */
export async function reapUsageMetrics(db: Database, now: Date = new Date()): Promise<void> {
  const { hourlyCutoff, dailyCutoff } = reapCutoffs(now);
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO usage_metrics (id, tenant_id, metric_type, resolution, measurement_timestamp, value)
      SELECT gen_random_uuid(), tenant_id, metric_type, 'daily'::usage_resolution,
             date_trunc('day', measurement_timestamp),
             CASE WHEN metric_type = 'bandwidth_gb' THEN sum(value) ELSE max(value) END
      FROM usage_metrics
      WHERE resolution = 'hourly' AND measurement_timestamp < ${hourlyCutoff}
      GROUP BY tenant_id, metric_type, date_trunc('day', measurement_timestamp)
      ON CONFLICT (tenant_id, metric_type, resolution, measurement_timestamp)
      DO UPDATE SET value = excluded.value
    `);
    await tx.execute(sql`
      DELETE FROM usage_metrics WHERE resolution = 'hourly' AND measurement_timestamp < ${hourlyCutoff}
    `);
    await tx.execute(sql`
      DELETE FROM usage_metrics WHERE resolution = 'daily' AND measurement_timestamp < ${dailyCutoff}
    `);
  });
}

/**
 * Phase 2 — historical usage rollup + reaper.
 *
 * Turns the previously-dead `usage_metrics` table into a bounded time-series:
 *   • WRITER  — one aggregate row per (tenant, metric_type, hour). Called from
 *     the hourly metrics-scheduler (cpu/mem/storage) and the bandwidth meter
 *     (bandwidth). No per-pod series (the operator's cardinality choice).
 *   • REAPER  — a daily job folds hourly rows older than 30d into daily rows,
 *     daily rows older than a year into monthly rows (kept 5y), then purges.
 *     This is what keeps growth bounded.
 *
 * Aggregate semantics differ per metric: bandwidth is a per-hour DELTA, so a day
 * (and a month) is the SUM of its parts (billing-grade); cpu/mem/storage are
 * gauges, so a day or a month keeps the peak (MAX) — the most useful signal for
 * capacity review.
 */

import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { usageMetrics } from '../../db/schema.js';
import { reapTrafficRollup } from '../traffic/rollup-store.js';
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
export const RETAIN_MONTHLY_MONTHS = 60;

/** UTC hour bucket (minutes/seconds/ms zeroed) — the hourly row's timestamp. */
export function hourBucketUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 0, 0, 0));
}

export interface ReapCutoffs {
  /** Hourly rows before this (a UTC midnight) are folded into days. */
  readonly hourlyCutoff: Date;
  /** Daily rows before this (a UTC month start) are folded into months. */
  readonly dailyCutoff: Date;
  /** Monthly rows before this (a UTC month start) are deleted. */
  readonly monthlyCutoff: Date;
}

/**
 * Reaper cutoffs, each aligned to the bucket it folds into, so only COMPLETE
 * days (and months) are folded — never a partial, still-growing one, which
 * would double-count bandwidth across reap runs. Days are kept at least a
 * year: the daily cutoff is the start of the month a year ago is in.
 */
export function reapCutoffs(now: Date): ReapCutoffs {
  const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const yearAgo = new Date(todayStartMs - RETAIN_DAILY_DAYS * 86_400_000);
  const dailyCutoff = new Date(Date.UTC(yearAgo.getUTCFullYear(), yearAgo.getUTCMonth(), 1));
  return {
    hourlyCutoff: new Date(todayStartMs - RETAIN_HOURLY_DAYS * 86_400_000),
    dailyCutoff,
    monthlyCutoff: new Date(Date.UTC(dailyCutoff.getUTCFullYear(), dailyCutoff.getUTCMonth() - RETAIN_MONTHLY_MONTHS, 1)),
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
 *   3. fold complete months of daily rows older than 1y into monthly rows,
 *   4. delete those daily rows,
 *   5. delete monthly rows older than 5y.
 * Then the traffic rollup's own fold, on the same cutoffs.
 */
export async function reapUsageMetrics(db: Database, now: Date = new Date()): Promise<void> {
  const { hourlyCutoff, dailyCutoff, monthlyCutoff } = reapCutoffs(now);
  await db.transaction(async (tx) => {
    // NB: the enum column is "metricType" (camelCase in the Drizzle schema) — it
    // must be double-quoted in raw SQL or Postgres folds it to metric_type.
    await tx.execute(sql`
      INSERT INTO usage_metrics (id, tenant_id, "metricType", resolution, measurement_timestamp, value)
      SELECT gen_random_uuid(), tenant_id, "metricType", 'daily'::usage_resolution,
             date_trunc('day', measurement_timestamp),
             CASE WHEN "metricType" = 'bandwidth_gb' THEN sum(value) ELSE max(value) END
      FROM usage_metrics
      WHERE resolution = 'hourly' AND measurement_timestamp < ${hourlyCutoff}
      GROUP BY tenant_id, "metricType", date_trunc('day', measurement_timestamp)
      ON CONFLICT (tenant_id, "metricType", resolution, measurement_timestamp)
      DO UPDATE SET value = excluded.value
    `);
    await tx.execute(sql`
      DELETE FROM usage_metrics WHERE resolution = 'hourly' AND measurement_timestamp < ${hourlyCutoff}
    `);
    await tx.execute(sql`
      INSERT INTO usage_metrics (id, tenant_id, "metricType", resolution, measurement_timestamp, value)
      SELECT gen_random_uuid(), tenant_id, "metricType", 'monthly'::usage_resolution,
             date_trunc('month', measurement_timestamp),
             CASE WHEN "metricType" = 'bandwidth_gb' THEN sum(value) ELSE max(value) END
      FROM usage_metrics
      WHERE resolution = 'daily' AND measurement_timestamp < ${dailyCutoff}
      GROUP BY tenant_id, "metricType", date_trunc('month', measurement_timestamp)
      ON CONFLICT (tenant_id, "metricType", resolution, measurement_timestamp)
      DO UPDATE SET value = excluded.value
    `);
    await tx.execute(sql`
      DELETE FROM usage_metrics WHERE resolution = 'daily' AND measurement_timestamp < ${dailyCutoff}
    `);
    await tx.execute(sql`
      DELETE FROM usage_metrics WHERE resolution = 'monthly' AND measurement_timestamp < ${monthlyCutoff}
    `);
  });
  await reapTrafficRollup(db, { hourlyCutoff, dailyCutoff, monthlyCutoff });
}

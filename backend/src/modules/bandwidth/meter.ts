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
 * Platform-scheduled backup egress is SUBTRACTED before accumulating: a
 * tenant's backup Job runs in the tenant's own namespace, so its upload to
 * off-site storage is measured exactly like a visitor download, and the tenant
 * is not the one who asked for it. Only `initiator = 'tenant'` backups are
 * billed. See `backup-exclusion.ts` for how a pod is tied back to the backup
 * that explains it — and why a bare pod-name pattern would have been a way for
 * a tenant to stop paying for traffic.
 *
 * Footprint: no per-tenant time-series is written here; the month-to-date total
 * lives on the tenant row. (Historical hourly rollup into usage_metrics + its
 * reaper is Phase 2.)
 */

import { eq } from 'drizzle-orm';
import { tenants, platformSettings } from '../../db/schema.js';
import { queryInstant } from '../monitoring/vm-client.js';
import { evaluateBandwidthThresholds } from './thresholds.js';
import { platformBackupBytesByNamespace } from './backup-exclusion.js';
import { recordHourlyUsage } from '../metrics/usage-rollup.js';
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
  const rows = await db
    .select({
      id: tenants.id,
      namespace: tenants.kubernetesNamespace,
      used: tenants.bandwidthGbUsed,
      cycleStart: tenants.bandwidthCycleStart,
      capped: tenants.bandwidthCapped,
      provisioningStatus: tenants.provisioningStatus,
    })
    .from(tenants);

  let byNamespace = new Map<string, number>();
  try {
    // EXTERNAL egress only — what the ingress served on the tenant's behalf.
    //
    // This used to sum `container_network_transmit_bytes_total` per
    // namespace, which is every byte the tenant's pods sent, including the
    // database answering the application over the pod network. Those bytes
    // never leave the node and a customer must not pay for them. Measured
    // on production over six hours: the active tenants were billed 4,687 MB
    // against 668 MB actually served — 7.0x overall, 190x for the most
    // database-heavy tenant — while tenants with no database add-on sat at
    // 1.0x, which is what identifies the excess as intra-namespace chatter
    // rather than real egress.
    //
    // `label_replace` folds Traefik's per-SERVICE counter onto the namespace
    // that owns it, so one tenant is one figure regardless of how many
    // routes they run.
    //
    // The trade-off, stated because it is a billing decision and not an
    // implementation detail: egress a workload initiates itself — an
    // outbound API call, SMTP, a package pull — does not pass through the
    // ingress and is therefore not billed. That under-counts. For a figure
    // the customer pays against, under-counting is the correct direction,
    // and it is the only number they can reconcile against their own route
    // page.
    const samples = await queryInstant(
      `sum by (namespace) (label_replace(`
      + `increase(traefik_service_responses_bytes_total{service=~"tenant-.+"}[${gapS}s])`
      + `, "namespace", "$1", "service", "^(tenant-[a-z0-9-]+?-[0-9a-f]{8})-.*"))`,
    );
    byNamespace = new Map(
      samples
        .map((s) => [s.labels.namespace ?? '', s.value] as const)
        .filter(([ns, v]) => ns.length > 0 && Number.isFinite(v) && v >= 0),
    );
    // ★ No backup exclusion any more, and removing it is REQUIRED rather
    // than tidy. It subtracted the bytes a platform-scheduled backup Job
    // shipped off-site, because the old per-namespace pod counter saw them
    // and billed them. The ingress counter cannot see them at all — a
    // backup Job talks to the off-site store, never through Traefik — so
    // subtracting them now would deduct bytes that were never added and
    // hand back bandwidth the tenant did use. The `Math.max(0, …)` below
    // would hide most of that as a floor rather than surface it.
    //
    // `platformBackupBytesByNamespace` and the reserved `bk-` name prefixes
    // it depends on are deliberately kept: they still describe which pods
    // are platform backups, which the bundle and traffic views rely on.
    void platformBackupBytesByNamespace;
  } catch (err) {
    logger.warn?.({ err }, 'bandwidth-meter: vmsingle query failed — skipping accumulation this tick');
    // Still advance lastRun? No — leave it so the next tick's wider window
    // (capped at MAX_GAP_S) recovers the missed bytes.
    return 0;
  }

  let updated = 0;
  const cycleAnchor = monthStartUtc(now);

  for (const t of rows) {
    if (t.provisioningStatus !== 'provisioned') continue;
    const rollover = isNewCycle(t.cycleStart, now);
    const priorUsed = rollover ? 0 : Number(t.used ?? 0);
    // Clamped at zero: the two queries are separate `increase()` evaluations
    // Nothing to deduct — see the note above the query. The clamp stays as a
    // floor against a counter reset mid-window, which `increase()` can
    // briefly report as negative.
    const billableBytes = Math.max(0, byNamespace.get(t.namespace) ?? 0);
    const deltaGb = bytesToGb(billableBytes);
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

    // Phase 2: persist the hour's bandwidth delta into the rollup store (SUM-
    // folded to daily for billing history). Skip zero-delta hours to stay lean.
    if (deltaGb > 0) {
      await recordHourlyUsage(db, t.id, { bandwidth_gb: deltaGb }, now);
    }

    // A month rollover that lifted an active cap must reconcile the tenant's
    // Ingress to REMOVE the maintenance-page redirect and restore serving.
    if (rollover && t.capped && t.namespace) {
      try {
        const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
        const { reconcileIngress } = await import('../domains/k8s-ingress.js');
        await reconcileIngress(db, createK8sClients(process.env.KUBECONFIG_PATH), t.id, t.namespace);
        logger.info?.({ tenantId: t.id }, 'bandwidth: cap lifted at month rollover — ingress restored');
      } catch (err) {
        logger.warn?.({ err, tenantId: t.id }, 'bandwidth: cap-lift ingress reconcile failed (will retry next tick)');
      }
    }
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

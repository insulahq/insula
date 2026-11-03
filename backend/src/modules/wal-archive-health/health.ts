/**
 * Pure WAL-archive health assessment (project_wal_archive_runaway_2026_06_02).
 *
 * Companion to the #162 plugin-presence fix. That fix stops the NO-target
 * case (a fresh cluster can't fill its volume with WAL). This module covers
 * the OTHER case: a SYSTEM target IS configured (barman plugin present) but
 * its sink is unreachable, so CNPG's `wal-archive` FAILS every segment,
 * Postgres can't recycle WAL, and pg_wal grows toward a full volume.
 *
 * Two jobs:
 *   1. ALERT loudly (the failure is invisible otherwise — proven on staging:
 *      CNPG surfaces `ContinuousArchiving=False` but nothing notified).
 *   2. CIRCUIT-BREAKER: if archiving keeps failing AND pg_wal climbs past a
 *      hard pressure threshold, AUTO-DISABLE archiving (remove the plugin →
 *      `wal-archive` no-op-succeeds → WAL recycles) so the volume can NEVER
 *      fill even if the alert goes unseen for days. A loud critical alert
 *      fires; an operator re-enables after fixing the sink.
 *
 * This file is PURE (no I/O) so the state machine is exhaustively testable.
 */

export type WalArchiveState = 'ok' | 'failing' | 'critical';
export type WalArchiveSeverity = 'warning' | 'error' | 'critical';

/** Point-in-time facts gathered by the scheduler's reader (I/O elsewhere). */
export interface WalArchiveSnapshot {
  readonly clusterName: string;
  /** Is the barman-cloud plugin present (i.e. archiving configured/attempted)? */
  readonly barmanPluginPresent: boolean;
  /**
   * Not failing: CNPG's ContinuousArchiving condition is anything but 'False'.
   * An absent or Unknown condition counts, so a just-attached plugin does not
   * alert before its first archive is reported.
   */
  readonly continuousArchivingHealthy: boolean;
  /**
   * Working: the condition is explicitly 'True'. Only this closes an alerted
   * failure — a condition that is briefly absent or Unknown during a restart
   * says nothing about whether WAL reaches the target again.
   */
  readonly continuousArchivingConfirmed: boolean;
  /**
   * While archiving fails: when it started failing, the condition's
   * lastTransitionTime (ISO-8601). Null while healthy, or when CNPG gave no
   * time. It also names the failure: one failure, one alert.
   */
  readonly failingSince: string | null;
  /** Total bytes in pg_wal (sum of pg_ls_waldir().size). */
  readonly walBytes: number;
  /** Data volume size in bytes (cluster spec.storage.size). 0 if unknown. */
  readonly volumeBytes: number;
}

export interface WalArchiveThresholds {
  /** Escalate the alert from warning → error at/above this pg_wal pressure %. */
  readonly warnPressurePct: number;
  /** Trip the circuit-breaker (auto-disable archiving) at/above this %. */
  readonly tripPressurePct: number;
  /**
   * Alert only once archiving has been failing this long. A failover fails the
   * new primary's first upload, then the retry succeeds seconds later: on
   * production one 5-minute tick read it inside that 4-second gap and sent
   * "failing" for a failure that was already over.
   */
  readonly alertAfterMs: number;
}

/**
 * Conservative defaults: escalate at 50%, hard-trip at 75% (room to spare),
 * alert after 10 minutes of failing. The wait never delays a trip, and a
 * pressure at or past warn alerts at once.
 */
export const DEFAULT_THRESHOLDS: WalArchiveThresholds = {
  warnPressurePct: 50,
  tripPressurePct: 75,
  alertAfterMs: 10 * 60_000,
};

export interface WalArchiveAssessment {
  readonly state: WalArchiveState;
  readonly pressurePct: number;
  /** Fire a failure notification. */
  readonly shouldAlert: boolean;
  /** Trip the breaker: disable archiving to prevent a full volume. */
  readonly shouldTrip: boolean;
  readonly severity: WalArchiveSeverity;
  readonly reason: string;
}

/** pg_wal as a % of the data volume (0 when volume size is unknown). */
export function pressurePercent(walBytes: number, volumeBytes: number): number {
  if (volumeBytes <= 0) return 0;
  return (walBytes / volumeBytes) * 100;
}

/**
 * Decide what to do from a snapshot. Pure + total.
 *
 * - No plugin → archiving is off (wal-archive no-op-succeeds, WAL recycles) → OK.
 * - Plugin present + ContinuousArchiving healthy → OK.
 * - Plugin present + archiving FAILING:
 *     pressure < warn  → state=failing, alert (warning) once failing ≥ alertAfterMs
 *     pressure ≥ warn  → state=failing, alert (error) at once
 *     pressure ≥ trip  → state=critical, alert (critical) + TRIP the breaker
 *   A failure with no known start alerts at once: an unknown age is not a short one.
 */
export function assessWalArchive(
  snapshot: WalArchiveSnapshot,
  thresholds: WalArchiveThresholds = DEFAULT_THRESHOLDS,
  nowMs: number = Date.now(),
): WalArchiveAssessment {
  const pressurePct = pressurePercent(snapshot.walBytes, snapshot.volumeBytes);
  const ok = (reason: string): WalArchiveAssessment => ({
    state: 'ok', pressurePct, shouldAlert: false, shouldTrip: false, severity: 'warning', reason,
  });

  // No archiver attached → CNPG's wal-archive no-op-succeeds → WAL recycles.
  // Nothing to alert on, and never trip (there's nothing to disable).
  if (!snapshot.barmanPluginPresent) {
    return ok('no barman plugin (archiving off — WAL recycles)');
  }
  // Configured + working.
  if (snapshot.continuousArchivingHealthy) {
    return ok('archiving healthy');
  }

  // Configured but FAILING — Postgres can't recycle un-archived WAL.
  const pct = Math.round(pressurePct);
  if (pressurePct >= thresholds.tripPressurePct) {
    return {
      state: 'critical', pressurePct, shouldAlert: true, shouldTrip: true, severity: 'critical',
      reason: `WAL archiving is failing and pg_wal is at ${pct}% of the data volume `
        + `(≥${thresholds.tripPressurePct}% trip threshold) — auto-disabling archiving to prevent a full volume`,
    };
  }
  const severity: WalArchiveSeverity = pressurePct >= thresholds.warnPressurePct ? 'error' : 'warning';
  const failingForMs = failingDurationMs(snapshot.failingSince, nowMs);
  const shouldAlert = severity === 'error'
    || failingForMs === null
    || failingForMs >= thresholds.alertAfterMs;
  return {
    state: 'failing', pressurePct, shouldAlert, shouldTrip: false, severity,
    reason: shouldAlert
      ? `WAL archiving is failing; pg_wal is at ${pct}% of the data volume`
      : `WAL archiving has been failing for ${minutes(failingForMs ?? 0)}; it alerts if it still fails `
        + `after ${minutes(thresholds.alertAfterMs)}`,
  };
}

/** How long archiving has been failing, or null when the start is unknown or unreadable. */
function failingDurationMs(failingSince: string | null, nowMs: number): number | null {
  if (!failingSince) return null;
  const since = Date.parse(failingSince);
  if (Number.isNaN(since)) return null;
  return Math.max(0, nowMs - since);
}

function minutes(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return m === 1 ? '1 minute' : `${m} minutes`;
}

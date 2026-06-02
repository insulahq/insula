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
  /** CNPG `status.conditions[ContinuousArchiving].status === 'True'`. */
  readonly continuousArchivingHealthy: boolean;
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
}

/** Conservative defaults: escalate at 50%, hard-trip at 75% (room to spare). */
export const DEFAULT_THRESHOLDS: WalArchiveThresholds = {
  warnPressurePct: 50,
  tripPressurePct: 75,
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
 *     pressure < warn  → state=failing, alert (warning)
 *     pressure ≥ warn  → state=failing, alert (error)
 *     pressure ≥ trip  → state=critical, alert (critical) + TRIP the breaker
 */
export function assessWalArchive(
  snapshot: WalArchiveSnapshot,
  thresholds: WalArchiveThresholds = DEFAULT_THRESHOLDS,
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
  return {
    state: 'failing', pressurePct, shouldAlert: true, shouldTrip: false, severity,
    reason: `WAL archiving is failing; pg_wal is at ${pct}% of the data volume`,
  };
}

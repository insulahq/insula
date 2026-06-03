/**
 * Upgrade pre-flight gates (ADR-045 W14) — pure evaluation over already-collected
 * facts, so the gate logic is fully unit-testable. A separate collector gathers
 * the facts from the live cluster (CNPG / Longhorn / nodes / lifecycle).
 *
 * Severity is environment-aware (locked decision: severity driven by the env
 * kind): on production a failing gate is BLOCKING; on dev/staging the same
 * condition is downgraded to a soft warning (staging absorbs risk).
 */

export type GateStatus = 'pass' | 'warn' | 'fail';

export interface PreflightGate {
  readonly id: string;
  readonly label: string;
  readonly status: GateStatus;
  readonly detail: string;
}

export interface PreflightResult {
  readonly gates: readonly PreflightGate[];
  /** True when no gate is a hard `fail` (a `warn` does not block). */
  readonly ok: boolean;
  /** Count of hard-failing gates. */
  readonly failures: number;
  readonly warnings: number;
}

export interface PreflightFacts {
  readonly environment: string; // 'production' | 'staging' | 'dev'
  /** CNPG primary reachable + a primary elected. */
  readonly cnpgReady: boolean;
  readonly cnpgDetail: string;
  /** Minimum healthy Longhorn replica count across volumes, or null if N/A. */
  readonly longhornMinReplicas: number | null;
  /** In-flight tenant lifecycle transitions, or null if the count is unknown
   *  (DB unreachable) — null is a soft warn, NEVER a fail-open pass. */
  readonly inFlightTransitions: number | null;
  /** Highest disk-used % across nodes, or null if unknown. */
  readonly maxDiskUsedPct: number | null;
  /** Age of the freshest CNPG backup in hours, or null if none/unknown. */
  readonly freshestBackupAgeHours: number | null;
}

const DISK_WARN_PCT = 80;
const DISK_FAIL_PCT = 90;
const BACKUP_STALE_HOURS = 24;

/** On production a problem blocks; on dev/staging it's a soft warning. */
function sev(environment: string, bad: boolean): GateStatus {
  if (!bad) return 'pass';
  return environment === 'production' ? 'fail' : 'warn';
}

export function evaluatePreflight(facts: PreflightFacts): PreflightResult {
  const env = facts.environment;
  const gates: PreflightGate[] = [];

  // 1. CNPG primary healthy
  gates.push({
    id: 'cnpg-healthy',
    label: 'Database (CNPG) healthy',
    status: sev(env, !facts.cnpgReady),
    detail: facts.cnpgReady ? facts.cnpgDetail || 'primary elected' : `not healthy: ${facts.cnpgDetail || 'no primary'}`,
  });

  // 2. Longhorn replica redundancy (need ≥2 so a node can roll during the upgrade)
  if (facts.longhornMinReplicas === null) {
    gates.push({ id: 'longhorn-replicas', label: 'Storage replica redundancy', status: 'pass', detail: 'no Longhorn volumes / not applicable' });
  } else {
    const low = facts.longhornMinReplicas < 2;
    gates.push({
      id: 'longhorn-replicas',
      label: 'Storage replica redundancy',
      status: sev(env, low),
      detail: low ? `min healthy replicas = ${facts.longhornMinReplicas} (< 2; a node roll could lose data availability)` : `min healthy replicas = ${facts.longhornMinReplicas}`,
    });
  }

  // 3. No in-flight tenant lifecycle transitions. Unknown (null = DB unreachable)
  //    is a WARN, never a fail-open pass — this gate is about nothing else
  //    mutating the cluster mid-upgrade, so "I can't tell" must not read as "safe".
  if (facts.inFlightTransitions === null) {
    gates.push({ id: 'no-in-flight-migrations', label: 'No in-flight tenant operations', status: 'warn', detail: 'transition count unknown (DB unreachable)' });
  } else {
    gates.push({
      id: 'no-in-flight-migrations',
      label: 'No in-flight tenant operations',
      status: sev(env, facts.inFlightTransitions > 0),
      detail: facts.inFlightTransitions > 0 ? `${facts.inFlightTransitions} tenant transition(s) in flight` : 'none in flight',
    });
  }

  // 4. Disk headroom
  if (facts.maxDiskUsedPct === null) {
    gates.push({ id: 'disk-headroom', label: 'Disk headroom', status: 'warn', detail: 'disk usage not collected (security-probe node data unavailable)' });
  } else if (facts.maxDiskUsedPct >= DISK_FAIL_PCT) {
    gates.push({ id: 'disk-headroom', label: 'Disk headroom', status: sev(env, true), detail: `max disk used ${facts.maxDiskUsedPct}% (≥ ${DISK_FAIL_PCT}%)` });
  } else if (facts.maxDiskUsedPct >= DISK_WARN_PCT) {
    gates.push({ id: 'disk-headroom', label: 'Disk headroom', status: 'warn', detail: `max disk used ${facts.maxDiskUsedPct}% (≥ ${DISK_WARN_PCT}%)` });
  } else {
    gates.push({ id: 'disk-headroom', label: 'Disk headroom', status: 'pass', detail: `max disk used ${facts.maxDiskUsedPct}%` });
  }

  // 5. Recent backup (rollback safety net) — warn-only (the operator can take a fresh one)
  if (facts.freshestBackupAgeHours === null) {
    gates.push({ id: 'recent-backup', label: 'Recent database backup', status: 'warn', detail: 'no recent backup found — take one before upgrading' });
  } else {
    const stale = facts.freshestBackupAgeHours > BACKUP_STALE_HOURS;
    gates.push({
      id: 'recent-backup',
      label: 'Recent database backup',
      status: stale ? 'warn' : 'pass',
      detail: `freshest backup ${facts.freshestBackupAgeHours}h old${stale ? ` (> ${BACKUP_STALE_HOURS}h — consider a fresh one)` : ''}`,
    });
  }

  const failures = gates.filter((g) => g.status === 'fail').length;
  const warnings = gates.filter((g) => g.status === 'warn').length;
  return { gates, ok: failures === 0, failures, warnings };
}

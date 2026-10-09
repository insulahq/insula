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
  /** Count of ATTACHED Longhorn volumes degraded/faulted below their configured
   *  redundancy (null = no volumes / not collectable). NOT a replica count — a
   *  healthy replica=1 volume on a single-node cluster is 0 at-risk, so
   *  single-node clusters are no longer blocked from upgrading. */
  readonly longhornAtRiskVolumes: number | null;
  /** In-flight tenant lifecycle transitions, or null if the count is unknown
   *  (DB unreachable) — null is a soft warn, NEVER a fail-open pass. */
  readonly inFlightTransitions: number | null;
  /** Highest disk-used % across nodes (node-health reconciler), or null if that
   *  metric is not populated (Phase 1 leaves it null until kubelet stats land). */
  readonly maxDiskUsedPct: number | null;
  /** Number of nodes the node-health reconciler reports under kubelet
   *  DiskPressure, or null when node-health has no data yet (no rows / DB
   *  unreachable). 0 = node-health reported and no node is under pressure. */
  readonly nodesWithDiskPressure: number | null;
  /** Age of the freshest CNPG backup in hours, or null if none/unknown. */
  readonly freshestBackupAgeHours: number | null;
  /** Suspended Flux objects the upgrade depends on (`Kind/name`: the platform
   *  Kustomization, its GitRepository); [] = reconciling, null = unreadable. */
  readonly fluxSuspended: readonly string[] | null;
  /** ADR-064: every node and whether it is Ready, or null = unreadable. Optional
   *  so callers that predate the run (the host CLI) keep compiling. */
  readonly nodes?: ReadonlyArray<{ readonly name: string; readonly ready: boolean }> | null;
  /** Nodes the operator chose to upgrade without. */
  readonly excludedNodes?: readonly string[];
  /** An upgrade run is already in flight; null = unreadable. */
  readonly upgradeRunning?: boolean | null;
  /**
   * ADR-064 §6, per node from its relayed host-migration status: a failed,
   * blocked or invalid host change, and whether it can verify a release.
   * null = unreadable.
   */
  readonly nodeHostState?: ReadonlyArray<{ readonly name: string; readonly hostFault: boolean; readonly trustAnchor: boolean | null }> | null;
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

  // 2. Longhorn storage redundancy. The gate blocks only when an ATTACHED
  //    volume is degraded/faulted BELOW its configured replica count — not on a
  //    hardcoded "< 2". A healthy replica=1 volume (the single-node default) is
  //    at its intended redundancy and passes; a replica=3 volume with a dead
  //    replica fails. Detached volumes are ignored (a node roll can't disrupt an
  //    unmounted volume). See collect-preflight.ts:longhornAtRiskVolumes.
  if (facts.longhornAtRiskVolumes === null) {
    gates.push({ id: 'longhorn-replicas', label: 'Storage replica redundancy', status: 'pass', detail: 'no Longhorn volumes / not applicable' });
  } else {
    const atRisk = facts.longhornAtRiskVolumes > 0;
    gates.push({
      id: 'longhorn-replicas',
      label: 'Storage replica redundancy',
      status: sev(env, atRisk),
      detail: atRisk
        ? `${facts.longhornAtRiskVolumes} attached volume(s) degraded below their configured redundancy — a node roll could lose data availability`
        : 'all attached volumes at their configured redundancy',
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

  // 4. Disk headroom — driven by the node-health reconciler's per-node data:
  //    a kubelet DiskPressure flag (collected today) plus an optional disk-used %
  //    (lights up when kubelet /stats/summary is wired). "Unknown" requires BOTH
  //    signals to be absent (node-health hasn't reported); otherwise a node fleet
  //    with no pressure is a clean PASS — fixing the prior perpetual-warn cry-wolf.
  {
    const pct = facts.maxDiskUsedPct;
    const pressured = facts.nodesWithDiskPressure;
    if (pct === null && pressured === null) {
      gates.push({ id: 'disk-headroom', label: 'Disk headroom', status: 'warn', detail: 'node disk data unavailable (node-health reconciler has not reported yet)' });
    } else if (pct !== null && pct >= DISK_FAIL_PCT) {
      const also = (pressured ?? 0) > 0 ? ` + ${pressured} under DiskPressure` : '';
      gates.push({ id: 'disk-headroom', label: 'Disk headroom', status: sev(env, true), detail: `max disk used ${pct}% (≥ ${DISK_FAIL_PCT}%)${also}` });
    } else if ((pressured ?? 0) > 0) {
      gates.push({ id: 'disk-headroom', label: 'Disk headroom', status: sev(env, true), detail: `${pressured} node(s) under kubelet DiskPressure` });
    } else if (pct !== null && pct >= DISK_WARN_PCT) {
      gates.push({ id: 'disk-headroom', label: 'Disk headroom', status: 'warn', detail: `max disk used ${pct}% (≥ ${DISK_WARN_PCT}%)` });
    } else {
      gates.push({ id: 'disk-headroom', label: 'Disk headroom', status: 'pass', detail: pct !== null ? `max disk used ${pct}%` : 'no node under disk pressure' });
    }
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

  // 6. Flux is actually reconciling the platform. The upgrade IS a re-pin of the
  //    platform source; with the Kustomization or its GitRepository suspended
  //    (the documented manual-rollback step) the re-pin changes nothing, while
  //    the API answered "Flux is reconciling" and post-flight counted failures
  //    to abort-recommended without ever naming the cause.
  if (facts.fluxSuspended === null) {
    gates.push({ id: 'flux-reconciling', label: 'Flux reconciling the platform', status: 'warn', detail: 'could not read the platform Kustomization / source — check `flux get kustomizations`' });
  } else {
    const names = facts.fluxSuspended;
    gates.push({
      id: 'flux-reconciling',
      label: 'Flux reconciling the platform',
      status: sev(env, names.length > 0),
      detail: names.length > 0
        ? `suspended: ${names.join(', ')} — the upgrade would change nothing; resume first (flux resume kustomization / flux resume source git)`
        : 'platform Kustomization and source reconciling',
    });
  }

  gates.push(...runGates(facts));

  const failures = gates.filter((g) => g.status === 'fail').length;
  const warnings = gates.filter((g) => g.status === 'warn').length;
  return { gates, ok: failures === 0, failures, warnings };
}

/**
 * ADR-064 gates: the upgrade updates every node before the services, so a node
 * that cannot take part blocks it — in every environment, because the run would
 * only wait for it — until the operator excludes it. An excluded node catches up
 * on its own update check when it is back.
 */
function runGates(facts: PreflightFacts): PreflightGate[] {
  const gates: PreflightGate[] = [];
  if (facts.upgradeRunning === true) {
    gates.push({ id: 'no-upgrade-running', label: 'No upgrade already running', status: 'fail', detail: 'an upgrade is in progress — wait for it to finish' });
  }
  gates.push(...hostGates(facts));
  if (facts.nodes === undefined) return gates;
  const label = 'Every node can take part';
  if (facts.nodes === null) {
    gates.push({ id: 'nodes-ready', label, status: 'warn', detail: 'could not list the nodes — the upgrade will wait for any node that is not Ready' });
    return gates;
  }
  const excluded = new Set(facts.excludedNodes ?? []);
  const included = facts.nodes.filter((n) => !excluded.has(n.name));
  const notReady = included.filter((n) => !n.ready).map((n) => n.name);
  const skipped = facts.nodes.filter((n) => excluded.has(n.name)).map((n) => n.name);
  const skippedNote = skipped.length > 0 ? ` Upgrading without ${skipped.join(', ')}: it catches up on its own update check when it is back.` : '';
  if (included.length === 0) {
    gates.push({ id: 'nodes-ready', label, status: 'fail', detail: 'every node is excluded — at least one node must take part' });
  } else if (notReady.length > 0) {
    gates.push({
      id: 'nodes-ready', label, status: 'fail',
      detail: `${notReady.join(', ')} ${notReady.length === 1 ? 'is' : 'are'} not Ready. Bring ${notReady.length === 1 ? 'it' : 'them'} back, or exclude ${notReady.length === 1 ? 'it' : 'them'} to upgrade without.${skippedNote}`,
    });
  } else {
    gates.push({ id: 'nodes-ready', label, status: 'pass', detail: `${included.length} node(s) Ready.${skippedNote}` });
  }
  return gates;
}

/**
 * A failed host change blocks every later one on its node, so an upgrade onto it
 * stacks more unapplied changes behind the failure — fix or skip it first. A node
 * that cannot verify a release would fail the node update outright. Both follow
 * the environment's severity like every other gate (blocking in production): the
 * signals are the node's own report, the same trust tier as its failed counts,
 * and the node update re-checks its key regardless. Excluded nodes are not judged.
 */
function hostGates(facts: PreflightFacts): PreflightGate[] {
  if (facts.nodeHostState === undefined) return [];
  if (facts.nodeHostState === null) {
    return [{ id: 'host-migrations-healthy', label: 'No failed host change on a node', status: 'warn', detail: 'could not read the nodes\' host-migration state' }];
  }
  const excluded = new Set(facts.excludedNodes ?? []);
  const nodes = facts.nodeHostState.filter((n) => !excluded.has(n.name));
  const faulty = nodes.filter((n) => n.hostFault).map((n) => n.name);
  const blind = nodes.filter((n) => n.trustAnchor === false).map((n) => n.name);
  return [
    {
      id: 'host-migrations-healthy',
      label: 'No failed host change on a node',
      status: sev(facts.environment, faulty.length > 0),
      detail: faulty.length > 0
        ? `${faulty.join(', ')}: a host change failed or is blocked — every later one waits behind it. Fix it or record a skip (Host migrations card).`
        : 'no node reports a failed host change',
    },
    {
      id: 'nodes-can-verify',
      label: 'Every node can verify a release',
      status: sev(facts.environment, blind.length > 0),
      detail: blind.length > 0
        ? `${blind.join(', ')}: /etc/platform/cosign.pub is missing or unreadable, so the node would refuse the release. Re-run the installer on it (insula bootstrap).`
        : 'no node reports a missing or unreadable signing key (a node on an older CLI does not report it yet and is not judged)',
    },
  ];
}

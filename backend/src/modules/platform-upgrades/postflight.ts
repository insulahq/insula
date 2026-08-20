/**
 * Upgrade post-flight (ADR-045 W14 follow-up) — pure evaluation of whether a
 * re-pinned upgrade has CONVERGED, plus a consecutive-failure streak so a
 * still-reconciling cluster is only escalated to `abort-recommended` after it
 * fails to converge for `ABORT_THRESHOLD` controlled-cadence observations.
 *
 * Split pure/impure like pre-flight: this file is fact-in → verdict-out (fully
 * unit-testable); a collector gathers the facts and an observer advances the
 * streak in platform_settings on the scheduler's tick.
 *
 * Right after a re-pin a `reconciling` result is EXPECTED (Flux takes minutes to
 * roll). The streak — advanced on a controlled cadence, NOT per UI poll — is what
 * distinguishes "still rolling" from "stuck / not converging → consider rollback".
 */

export type PostflightGateStatus = 'pass' | 'warn' | 'fail';

/** consecutiveFailures at/above this flips the verdict to abort-recommended. */
export const ABORT_THRESHOLD = 3;

export interface PostflightGate {
  readonly id: string;
  readonly label: string;
  readonly status: PostflightGateStatus;
  readonly detail: string;
}

export type PostflightPhase = 'idle' | 'reconciling' | 'healthy';
export type PostflightVerdict = 'idle' | 'healthy' | 'reconciling' | 'abort-recommended';

/** Migration facts. Optional so a caller that cannot read them degrades to the
 *  pre-existing four gates rather than failing. */
export interface PostflightMigrationFacts {
  /** false when the registry could not be read at all. */
  readonly migrationsReadable?: boolean;
  /** Ids of migrations that FAILED — the registry halts on the first. */
  readonly migrationsFailed?: readonly string[];
  /** Count not yet applied (0 on a converged cluster). */
  readonly migrationsPending?: number;
  /** undefined = not reported yet by any node. */
  readonly hostMigrationsDegraded?: boolean;
  readonly hostMigrationsDetail?: string;
}

export interface PostflightResult {
  readonly gates: readonly PostflightGate[];
  /** True when no gate is a hard `fail`. */
  readonly ok: boolean;
  readonly failures: number;
  readonly warnings: number;
  readonly phase: PostflightPhase;
}

export interface PostflightFacts extends PostflightMigrationFacts {
  /** The in-flight target (platform_settings pending_update_version); null = no upgrade in flight. */
  readonly pendingVersion: string | null;
  /** The live pod's running version. */
  readonly runningVersion: string;
  /** CNPG primary reachable + a primary elected. */
  readonly cnpgReady: boolean;
  readonly cnpgDetail: string;
  /** Platform-namespace Deployments: total and those reporting fully available. */
  readonly deploymentsTotal: number;
  readonly deploymentsAvailable: number;
  /** False when the Deployment list could not be read (k8s API error) — a
   *  distinct fail ("unreadable") from "N of M down", never a fail-open pass. */
  readonly deploymentsReadable: boolean;
  /** Platform-namespace pods currently crash-looping (CrashLoopBackOff / repeated restarts). */
  readonly crashloopingPods: number;
}

/**
 * Evaluate convergence of an in-flight upgrade. With no upgrade in flight
 * (`pendingVersion === null`) this is a benign `idle` (no gates, ok=true).
 */
export function evaluatePostflight(facts: PostflightFacts): PostflightResult {
  if (facts.pendingVersion === null) {
    return { gates: [], ok: true, failures: 0, warnings: 0, phase: 'idle' };
  }

  const gates: PostflightGate[] = [];

  // 1. Version converged — the running pod reports the target version. A mismatch
  //    is a `fail` (still reconciling), NOT a warn: it's the core convergence signal.
  const converged = facts.runningVersion === facts.pendingVersion;
  gates.push({
    id: 'version-converged',
    label: 'Running version matches target',
    status: converged ? 'pass' : 'fail',
    detail: converged ? `running ${facts.runningVersion}` : `running ${facts.runningVersion}, target ${facts.pendingVersion}`,
  });

  // 2. CNPG healthy after the roll.
  gates.push({
    id: 'cnpg-healthy',
    label: 'Database (CNPG) healthy',
    status: facts.cnpgReady ? 'pass' : 'fail',
    detail: facts.cnpgReady ? facts.cnpgDetail || 'primary elected' : `not healthy: ${facts.cnpgDetail || 'no primary'}`,
  });

  // 3. All platform Deployments available. An unreadable list is a distinct
  //    fail ("k8s API error"), never conflated with "N of M down".
  if (!facts.deploymentsReadable) {
    gates.push({ id: 'deployments-available', label: 'Platform deployments available', status: 'fail', detail: 'deployment health unreadable (k8s API error)' });
  } else {
    const allUp = facts.deploymentsTotal > 0 && facts.deploymentsAvailable >= facts.deploymentsTotal;
    gates.push({
      id: 'deployments-available',
      label: 'Platform deployments available',
      status: allUp ? 'pass' : 'fail',
      detail: `${facts.deploymentsAvailable}/${facts.deploymentsTotal} deployments available`,
    });
  }

  // 4. No crash-looping pods.
  gates.push({
    id: 'no-crashloops',
    label: 'No crash-looping pods',
    status: facts.crashloopingPods === 0 ? 'pass' : 'fail',
    detail: facts.crashloopingPods === 0 ? 'none crash-looping' : `${facts.crashloopingPods} pod(s) crash-looping`,
  });

  // 5-6. Migrations. An upgrade is not done when its images are — the images
  //       are only the part Flux can see.
  //
  //       Both gates are 'fail' (which reads as *reconciling*, not *broken* —
  //       see the phase note below) rather than 'warn', because a cluster
  //       running new code against an unconverged base is exactly the state
  //       that must not clear `pending_update_version`. On 2026-08-19 all four
  //       gates above passed on three clusters whose platform-migration
  //       registry had halted at 0008, so the upgrade reported healthy while
  //       the wildcard ClusterIssuer it needed had never been created.
  //
  //       UX note: these are DELIBERATELY not surfaced as errors while still
  //       converging. Platform migrations land seconds after the pod starts;
  //       host migrations land when the node's converge runs. Calling either
  //       "incomplete" during its normal window would train operators to
  //       dismiss the signal, so the modal renders `reconciling` gates as
  //       progress and only the stalled/failed reasons in red.
  if (facts.migrationsReadable === false) {
    // Unreadable ≠ converged. Distinct detail so it is never mistaken for
    // "0 pending".
    gates.push({
      id: 'migrations-converged',
      label: 'Platform migrations applied',
      status: 'fail',
      detail: 'migration status unreadable',
    });
  } else if (facts.migrationsFailed && facts.migrationsFailed.length > 0) {
    gates.push({
      id: 'migrations-converged',
      label: 'Platform migrations applied',
      status: 'fail',
      // Name the migration: "a migration failed" is what made this invisible.
      detail: `HALTED on ${facts.migrationsFailed.join(', ')} — later migrations are blocked`,
    });
  } else {
    const pending = facts.migrationsPending ?? 0;
    gates.push({
      id: 'migrations-converged',
      label: 'Platform migrations applied',
      status: pending === 0 ? 'pass' : 'fail',
      detail: pending === 0 ? 'registry converged' : `${pending} migration(s) not yet applied`,
    });
  }

  // Host migrations converge per node on their own timer (immediately after a
  // self-upgrade installs the release's binary, then hourly). Unknown is
  // tolerated as a pass: a cluster whose nodes have not reported yet must not
  // block an otherwise healthy upgrade forever — the dedicated status relay and
  // its own alerting own that case.
  if (facts.hostMigrationsDegraded === true) {
    gates.push({
      id: 'host-migrations-converged',
      label: 'Host migrations applied',
      status: 'fail',
      detail: facts.hostMigrationsDetail || 'one or more nodes have a failed or blocked host-migration',
    });
  } else if (facts.hostMigrationsDegraded === false) {
    gates.push({
      id: 'host-migrations-converged',
      label: 'Host migrations applied',
      status: 'pass',
      detail: facts.hostMigrationsDetail || 'all nodes converged',
    });
  }

  const failures = gates.filter((g) => g.status === 'fail').length;
  const warnings = gates.filter((g) => g.status === 'warn').length;
  const ok = failures === 0;
  // Healthy requires BOTH a clean run AND version convergence — a clean run on the
  // OLD version (Flux hasn't rolled yet) is still `reconciling`, not done.
  const phase: PostflightPhase = ok && converged ? 'healthy' : 'reconciling';
  return { gates, ok, failures, warnings, phase };
}

export interface StreakAssessment {
  readonly consecutiveFailures: number;
  readonly verdict: PostflightVerdict;
}

/**
 * Advance the consecutive-failure streak given the prior count and this
 * observation. `healthy`/`idle` reset the streak to 0; a non-healthy observation
 * increments it, and once it reaches ABORT_THRESHOLD the verdict escalates to
 * `abort-recommended`. Pure — the observer persists the returned count.
 */
export function advanceStreak(prevConsecutiveFailures: number, result: PostflightResult): StreakAssessment {
  const prev = Number.isFinite(prevConsecutiveFailures) && prevConsecutiveFailures > 0 ? Math.floor(prevConsecutiveFailures) : 0;
  if (result.phase === 'idle') return { consecutiveFailures: 0, verdict: 'idle' };
  if (result.phase === 'healthy') return { consecutiveFailures: 0, verdict: 'healthy' };
  const consecutiveFailures = prev + 1;
  const verdict: PostflightVerdict = consecutiveFailures >= ABORT_THRESHOLD ? 'abort-recommended' : 'reconciling';
  return { consecutiveFailures, verdict };
}

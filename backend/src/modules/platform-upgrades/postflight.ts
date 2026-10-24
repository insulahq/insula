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

/**
 * CloudNativePG phases (api/v1 cluster_types.go) in which the operator restarts or
 * rolls instances on purpose: an operator upgrade, a spec change, a switchover.
 * While the platform database is in one of them, new connections are refused for
 * a while and a new API pod cannot start, so the services look stuck though
 * nothing is wrong (measured on staging: the third check fell in a database roll
 * and told the operator to consider rolling back). Failing over, a supervised
 * upgrade waiting for the operator and every error phase are deliberately absent.
 */
export const PLANNED_DATABASE_RESTART_PHASES: ReadonlySet<string> = new Set([
  'Upgrading cluster',
  'Waiting for the instances to become active',
  'Primary instance is being restarted in-place',
  'Primary instance is being restarted without a switchover',
  'Switchover in progress',
  'Online upgrade in progress',
  'Applying configuration',
]);

/**
 * Streak checks a planned database restart may hold per upgrade — about six
 * minutes at the slow cadence. Bounded, so a restart that never finishes (an
 * instance that cannot be scheduled) still escalates.
 */
export const MAX_DATABASE_RESTART_HOLDS = 3;

export interface PostflightGate {
  readonly id: string;
  readonly label: string;
  readonly status: PostflightGateStatus;
  readonly detail: string;
  /** A `warn` that means "not run yet", not a fault (rendered as catching up). */
  readonly scheduled?: boolean;
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
  /**
   * The nodes' host-migration state against the target release
   * (host-migration-status.ts assessHostMigrations). Never a `fail`: reported,
   * not blocking. undefined = not collected (callers without a cluster).
   */
  readonly hostMigrations?: {
    readonly status: 'pass' | 'warn';
    readonly scheduled: boolean;
    readonly detail: string;
  };
}

export interface PostflightResult {
  readonly gates: readonly PostflightGate[];
  /** True when no gate is a hard `fail`. */
  readonly ok: boolean;
  readonly failures: number;
  readonly warnings: number;
  readonly phase: PostflightPhase;
  /** Still reconciling while the platform database restarts on purpose. */
  readonly databaseRestarting?: boolean;
}

export interface PostflightFacts extends PostflightMigrationFacts {
  /** The in-flight target (platform_settings pending_update_version); null = no upgrade in flight. */
  readonly pendingVersion: string | null;
  /** The live pod's running version. */
  readonly runningVersion: string;
  /** CNPG primary reachable + a primary elected. */
  readonly cnpgReady: boolean;
  readonly cnpgDetail: string;
  /** The CNPG Cluster's status.phase; undefined when it could not be read. */
  readonly cnpgPhase?: string;
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
  // that must not clear `pending_update_version`. all four
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

  // Host migrations are REPORTED here, never blocking. The upgrade run (ADR-064)
  // updates the nodes before the services and finishes after-services changes
  // after them; a node it left out (excluded, or one that joined later) catches up
  // on its hourly update timer and is legitimately behind meanwhile. Neither may
  // hold the services' convergence: that turned a node's timer into "not
  // converging" and one old failure into an upgrade that never finished.
  // `scheduled` tells the UI a behind node is catching up, not broken.
  if (facts.hostMigrations) {
    gates.push({
      id: 'host-migrations-converged',
      label: 'Host migrations',
      status: facts.hostMigrations.status,
      detail: facts.hostMigrations.detail,
      scheduled: facts.hostMigrations.scheduled,
    });
  }

  const failures = gates.filter((g) => g.status === 'fail').length;
  const warnings = gates.filter((g) => g.status === 'warn').length;
  const ok = failures === 0;
  // Healthy requires BOTH a clean run AND version convergence — a clean run on the
  // OLD version (Flux hasn't rolled yet) is still `reconciling`, not done.
  const phase: PostflightPhase = ok && converged ? 'healthy' : 'reconciling';
  const databaseRestarting = phase === 'reconciling' && PLANNED_DATABASE_RESTART_PHASES.has(facts.cnpgPhase ?? '');
  return { gates, ok, failures, warnings, phase, databaseRestarting };
}

export interface StreakAssessment {
  readonly consecutiveFailures: number;
  readonly verdict: PostflightVerdict;
  /** Holds spent on planned database restarts during this upgrade. */
  readonly databaseRestartHolds: number;
}

const nonNegativeCount = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
const verdictFor = (consecutiveFailures: number): PostflightVerdict =>
  consecutiveFailures >= ABORT_THRESHOLD ? 'abort-recommended' : 'reconciling';

/**
 * Advance the consecutive-failure streak given the prior count and this
 * observation. `healthy`/`idle` reset the streak (and the holds) to 0; a
 * non-healthy observation increments it, and once it reaches ABORT_THRESHOLD the
 * verdict escalates to `abort-recommended`. A planned database restart holds the
 * streak where it is instead, at most MAX_DATABASE_RESTART_HOLDS times per
 * upgrade. Pure — the observer persists the returned counts.
 */
export function advanceStreak(
  prevConsecutiveFailures: number,
  result: PostflightResult,
  prevDatabaseRestartHolds: number,
): StreakAssessment {
  const prev = nonNegativeCount(prevConsecutiveFailures);
  const holds = nonNegativeCount(prevDatabaseRestartHolds);
  if (result.phase === 'idle') return { consecutiveFailures: 0, verdict: 'idle', databaseRestartHolds: 0 };
  if (result.phase === 'healthy') return { consecutiveFailures: 0, verdict: 'healthy', databaseRestartHolds: 0 };
  if (result.databaseRestarting && holds < MAX_DATABASE_RESTART_HOLDS) {
    return { consecutiveFailures: prev, verdict: verdictFor(prev), databaseRestartHolds: holds + 1 };
  }
  const consecutiveFailures = prev + 1;
  return { consecutiveFailures, verdict: verdictFor(consecutiveFailures), databaseRestartHolds: holds };
}

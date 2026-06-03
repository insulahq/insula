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

export interface PostflightResult {
  readonly gates: readonly PostflightGate[];
  /** True when no gate is a hard `fail`. */
  readonly ok: boolean;
  readonly failures: number;
  readonly warnings: number;
  readonly phase: PostflightPhase;
}

export interface PostflightFacts {
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

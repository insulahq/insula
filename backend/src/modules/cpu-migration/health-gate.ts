/**
 * The pause between re-tiers (ADR-062 R2).
 *
 * A migration recreates a tenant's pods one workload at a time. Between each,
 * the runner waits for the cluster to settle — otherwise a failure on the
 * first workload is discovered only after the remaining ten have been
 * recreated on top of it, and the operator is left with a half-migrated
 * tenant and no clear point to revert to.
 *
 * Pure: the caller reads the cluster, this decides what the reading means.
 */

export interface WorkloadReadiness {
  readonly name: string;
  readonly desiredReplicas: number;
  readonly readyReplicas: number;
  /**
   * Set when the ReplicaSet itself refuses to create pods — a quota
   * rejection, an unschedulable pod. Distinct from "not ready yet".
   */
  readonly failureMessage: string | null;
}

export type GateVerdict =
  | { readonly state: 'healthy' }
  | { readonly state: 'settling'; readonly waitingOn: readonly string[] }
  | { readonly state: 'broken'; readonly reason: string; readonly workload: string };

/**
 * ★ "Not ready yet" and "will never be ready" are different, and conflating
 * them is how a paced migration turns into a stuck one — or worse, a fast one
 * that keeps going through a failure.
 *
 * A workload mid-rollout is SETTLING: the right response is to wait. A
 * workload whose ReplicaSet is reporting a failure is BROKEN: waiting will
 * not fix it, and continuing would stack the next re-tier on top. A quota
 * rejection is the failure this migration can actually cause, so it must stop
 * the run rather than time out into one.
 *
 * A deployment scaled to zero on purpose is healthy — 0 desired, 0 ready.
 * Treating it as unhealthy would block every migration of a tenant with a
 * deliberately stopped workload.
 */
export function assessWorkloads(workloads: readonly WorkloadReadiness[]): GateVerdict {
  for (const w of workloads) {
    if (w.failureMessage) {
      return { state: 'broken', reason: w.failureMessage, workload: w.name };
    }
  }
  const waitingOn = workloads
    .filter((w) => w.readyReplicas < w.desiredReplicas)
    .map((w) => w.name);
  if (waitingOn.length > 0) return { state: 'settling', waitingOn };
  return { state: 'healthy' };
}

export interface GateOutcome {
  readonly ok: boolean;
  readonly verdict: GateVerdict;
  /** True when the gate gave up waiting rather than observing a failure. */
  readonly timedOut: boolean;
}

export interface WaitOptions {
  readonly timeoutMs: number;
  readonly pollMs: number;
  /** Injected so tests do not sleep, and so a stop request can interrupt. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** Polled between attempts; true aborts the wait. */
  readonly stopRequested?: () => Promise<boolean>;
}

/**
 * Wait until the tenant settles, something breaks, or we run out of patience.
 *
 * A timeout is NOT success. It returns ok:false with timedOut:true so the
 * caller can say "gave up waiting" rather than reporting a healthy tenant it
 * never actually observed — the failure mode where a migration reports green
 * over a tenant that is still down.
 */
export async function waitForHealthy(
  read: () => Promise<readonly WorkloadReadiness[]>,
  opts: WaitOptions,
): Promise<GateOutcome> {
  const deadline = opts.now() + opts.timeoutMs;
  let verdict: GateVerdict = { state: 'settling', waitingOn: [] };
  for (;;) {
    verdict = assessWorkloads(await read());
    if (verdict.state === 'healthy') return { ok: true, verdict, timedOut: false };
    if (verdict.state === 'broken') return { ok: false, verdict, timedOut: false };
    if (opts.stopRequested && await opts.stopRequested()) {
      return { ok: false, verdict, timedOut: false };
    }
    if (opts.now() >= deadline) return { ok: false, verdict, timedOut: true };
    await opts.sleep(opts.pollMs);
  }
}

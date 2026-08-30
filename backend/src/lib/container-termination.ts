/**
 * Classifying a container termination — in particular, recognising an
 * out-of-memory kill.
 *
 * WHY THIS EXISTS
 * ---------------
 * The obvious test — `terminated.reason === 'OOMKilled'` — misses real OOM
 * kills. Observed on the production cluster 2026-08-30: the VictoriaMetrics
 * pod was killed by its own memory cgroup —
 *
 *   kernel: Memory cgroup out of memory: Killed process 23616 (victoria-metric)
 *   memory.events: oom_kill 2, oom_group_kill 1
 *
 * — and the kubelet recorded the termination as:
 *
 *   lastState.terminated: { exitCode: 137, reason: "Error" }
 *
 * Not "OOMKilled". A sweep for `reason == "OOMKilled"` across every namespace
 * returned ZERO results while that pod was being OOM-killed every ~2 days.
 * The cgroup performed a group kill, and the reason the kubelet attaches in
 * that path is not reliably "OOMKilled".
 *
 * Exit code 137 is 128 + SIGKILL(9). It is not *exclusively* an OOM — any
 * SIGKILL produces it, including a `kubectl delete --grace-period=0` or a
 * failed liveness probe that escalated. But for a container the kubelet then
 * restarted, memory is overwhelmingly the cause, and answering "OOMKilled"
 * gives the operator the one actionable diagnosis (the memory limit) instead
 * of the bare "Error" that hid this for weeks.
 *
 * Use these helpers everywhere a termination is classified. Comparing against
 * the literal 'OOMKilled' at a call site is the bug this module replaces —
 * `scripts/ci-oom-classification-check.sh` fails the build on a new one.
 */

/** 128 + SIGKILL(9). What the kubelet reports for a cgroup OOM group kill. */
export const OOM_EXIT_CODE = 137;

/** The subset of a k8s ContainerStateTerminated that classification needs. */
export interface TerminationState {
  readonly reason?: string;
  readonly exitCode?: number;
}

/**
 * How an OOM was established:
 *   'explicit' — the kubelet said so.
 *   'inferred' — a bare SIGKILL we are attributing to memory.
 *   null       — not an OOM.
 *
 * Worth distinguishing when reporting to an operator: "OOM-killed at its
 * memory limit" is a statement of fact, while an inferred kill should say so,
 * because a SIGKILL can also come from elsewhere. `node-health/memory-events`
 * has always drawn this line and its wording is the reason this is a
 * three-valued function rather than a boolean.
 */
export type OomClassification = 'explicit' | 'inferred' | null;

export function classifyOom(t: TerminationState | undefined | null): OomClassification {
  if (!t) return null;
  if (t.reason === 'OOMKilled') return 'explicit';
  if (t.exitCode === OOM_EXIT_CODE) return 'inferred';
  return null;
}

/**
 * True when this termination should be treated as out-of-memory.
 *
 * Accepts the explicit kubelet reason OR a bare SIGKILL exit, because the
 * kubelet does not always set the former for a kill it did not observe
 * directly (see the module comment).
 */
// Deliberately NOT a type predicate. `t is T` would narrow the FALSE branch to
// undefined|null, which is a lie: a termination that isn't an OOM is still a
// termination. Written as a predicate first, and tsc immediately caught it —
// reconcile.ts reads terminated.exitCode in exactly that else-branch and got
// `Property 'exitCode' does not exist on type 'never'`. Callers that need
// non-null narrowing should test for the value itself.
export function isOomTermination(t: TerminationState | undefined | null): boolean {
  return classifyOom(t) !== null;
}

/**
 * The reason to show an operator, upgrading an unexplained SIGKILL to the
 * actionable diagnosis. Returns null when there is no termination at all, so
 * callers can keep distinguishing "not terminated" from "terminated, reason
 * unknown".
 */
export function describeTermination(t: TerminationState | undefined | null): string | null {
  if (!t) return null;
  if (isOomTermination(t)) return 'OOMKilled';
  return t.reason ?? null;
}

/**
 * True when a free-text status/error message describes an OOM kill. For the
 * paths that only ever see a rendered string (a CNPG import failure relayed
 * as text, an event message) rather than a structured termination.
 */
export function messageIndicatesOom(message: string): boolean {
  return message.includes('OOMKilled') || message.includes(`exit code ${OOM_EXIT_CODE}`);
}

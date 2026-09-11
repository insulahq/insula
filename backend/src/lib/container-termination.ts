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

/**
 * Pod-level status fields that say a SIGKILL was EXPECTED.
 *
 * WHY THIS EXISTS
 * ---------------
 * The exit-137 inference above is what catches cgroup group-kills the kubelet
 * labels `reason: "Error"`. It also catches every SIGKILL that has nothing to
 * do with memory — and the biggest source of those is a node reboot.
 *
 * Measured on production 2026-09-11. A graceful node shutdown SIGKILLs any
 * container still alive at the end of its `shutdownGracePeriodByPodPriority`
 * group. Five containers exited 137 that way; all five were reported as OOM,
 * three of them to admins as "<tenant>: apache-php OOM-killed". The kernel ring
 * buffer for that boot held ZERO cgroup OOM kills, the node never left
 * `MemoryPressure=False` with 8 GiB free, no pod was ever evicted, and the live
 * replacements sat at 20-32% of their limits. Eight of the thirteen inferred
 * OOMs ever recorded on that cluster were reboot debris from two reboots.
 *
 * The kubelet hands us the answer in the pod's own status:
 *
 *   status.reason  = "Terminated"    status.message = "Pod was terminated in
 *                                     response to imminent node shutdown."
 *   status.reason  = "NodeShutdown"  status.message = "Pod was rejected as the
 *                                     node is shutting down."
 *
 * Neither carries `deletionTimestamp` — the pod is never deleted, just marked
 * Failed — which is why the `deletionTimestamp`-only guard in
 * node-health/memory-events.ts (correct for rollout SIGKILLs) did not catch it.
 *
 * Deliberately NOT `restartCount > 0`, which the module comment above uses as
 * its informal justification: a `restartPolicy: Never` pod (a Job) that really
 * is OOM-killed has restartCount 0 and carries the kill in `state.terminated`.
 * Gating on the restart count would trade this false positive for a false
 * negative. The pod-level shutdown markers are what actually distinguish them.
 */
export interface PodShutdownState {
  readonly deletionTimestamp?: string;
  /** Pod-level `status.reason` (NOT the container's `terminated.reason`). */
  readonly reason?: string;
}

/**
 * `status.reason` values the kubelet sets on pods it killed or refused because
 * the node was going down. `Terminated` is the graceful-shutdown manager's own
 * reason string, `NodeShutdown` the admission rejection for a replacement the
 * scheduler bound to an already-draining node.
 */
export const NODE_SHUTDOWN_POD_REASONS: readonly string[] = ['NodeShutdown', 'Terminated'];

/**
 * True when this pod's containers were SIGKILLed by design — a deletion
 * (rollout, scale-down, drain) or a node shutdown. An *inferred* OOM on such a
 * pod is meaningless and must be dropped; an EXPLICIT `OOMKilled` from the
 * kubelet still counts, because a container can genuinely hit its limit while
 * the pod happens to be shutting down.
 */
export function isExpectedSigkill(pod: PodShutdownState | undefined | null): boolean {
  if (!pod) return false;
  if (pod.deletionTimestamp) return true;
  return pod.reason !== undefined && NODE_SHUTDOWN_POD_REASONS.includes(pod.reason);
}

/**
 * Pod-level fields needed to tell a LIVE pod from a dead record its controller
 * has already replaced.
 */
export interface PodRecordState extends PodShutdownState {
  /** Pod-level `status.phase`. */
  readonly phase?: string;
}

/**
 * True when this pod object is a dead record rather than a running workload.
 *
 * WHY THIS EXISTS
 * ---------------
 * Nothing in Kubernetes deletes a terminal pod promptly
 * (`--terminated-pod-gc-threshold` defaults to 12500), so a Deployment that is
 * serving perfectly well can have `Failed`/`Succeeded` corpses sitting beside
 * its live replica for days. Any scan that looks for failure signals across
 * `listNamespacedPod(app=<name>)` will read those corpses, and a corpse from a
 * node reboot carries `exitCode: 137` — which `classifyOom()` infers as an OOM.
 *
 * Measured on production 2026-09-11: three tenants (`my-apache-php`,
 * `fpl-app`, `perfex`) were shown as FAILED with "Workload ran out of memory"
 * while every one of them was `1/1` READY. Each namespace held exactly one
 * `status.reason=Terminated` corpse from that morning's reboot. Deleting the
 * four corpses flipped all three rows back to `running` on the next 15 s
 * reconcile tick, with no change to the live pods.
 *
 * A terminal pod says nothing about the workload's CURRENT state: its
 * controller observed the terminal phase and made the replacement. The live
 * replica's own `state`/`lastState` is what carries a real crash, and
 * `readyReplicas` is what carries a real outage.
 *
 * Broader than {@link isExpectedSigkill}, which answers a different question —
 * "was this SIGKILL expected?" — and deliberately still lets an EXPLICIT
 * `OOMKilled` through, because a container can genuinely hit its limit while
 * its pod is being drained. For "is this pod still the workload?" the phase
 * settles it whatever the kill reason was.
 */
export function isReplacedPodRecord(pod: PodRecordState | undefined | null): boolean {
  if (!pod) return false;
  if (pod.phase === 'Failed' || pod.phase === 'Succeeded') return true;
  return isExpectedSigkill(pod);
}

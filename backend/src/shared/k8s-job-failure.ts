/**
 * Say WHY a Job failed, not just that it did.
 *
 * The Job watchers used to report `failed?.message ?? 'Job failed'`. For a pod
 * that never started that is all anyone ever saw: there is no log to tail, the
 * pod is deleted the moment the deadline passes, and the events that named the
 * cause expire an hour later. A production capture Job sat 29 minutes on a
 * Multi-Attach error — pinned to a node its RWO volume could not attach to — and
 * the bundle recorded "Job failed".
 *
 * Three sources, read once at failure time:
 *   - the Job condition: `Failed`, else `FailureTarget`. Kubernetes sets
 *     FailureTarget first and only adds Failed after the pods are gone, so a
 *     watcher that reacts to `status.failed > 0` usually sees FailureTarget only;
 *   - the pod, if it still exists: its node and why its container is waiting;
 *   - Warning events for the Job's pods. The pod names come from the Job's own
 *     "Created pod: …" events, which outlive the pods.
 *
 * The condition is the headline. Everything else names nodes, pods and raw
 * event text, so it is operator-only: `formatJobFailure` puts it behind
 * DIAGNOSIS_MARKER, which every tenant-facing surface cuts at.
 *
 * Never throws: a diagnosis that fails must not replace the failure it explains.
 */
import { DIAGNOSIS_MARKER } from './operator-only-text.js';

export interface JobConditionLite {
  readonly type: string;
  readonly status: string;
  readonly reason?: string;
  readonly message?: string;
}

export interface PodLite {
  readonly metadata?: { readonly name?: string };
  readonly spec?: { readonly nodeName?: string };
  readonly status?: {
    readonly phase?: string;
    readonly conditions?: ReadonlyArray<{ type?: string; status?: string; reason?: string; message?: string }>;
    readonly containerStatuses?: ReadonlyArray<{
      readonly state?: {
        readonly waiting?: { reason?: string; message?: string };
        readonly terminated?: { exitCode?: number; reason?: string };
      };
    }>;
  };
}

export interface EventLite {
  readonly type?: string;
  readonly reason?: string;
  readonly message?: string;
  readonly involvedObject?: { readonly kind?: string; readonly name?: string };
  readonly lastTimestamp?: Date | string;
  readonly eventTime?: Date | string;
}

/** The two core reads this needs — narrower than CoreV1Api so a fake is easy. */
export interface JobFailureCore {
  listNamespacedPod(args: { namespace: string; labelSelector?: string }): Promise<{ items?: unknown[] }>;
  listNamespacedEvent(args: { namespace: string; fieldSelector?: string }): Promise<{ items?: unknown[] }>;
}

export interface JobFailureDescription {
  /** The Job condition ("Reason: message"), or "Job failed". Tenant-safe. */
  readonly reason: string;
  /** Pod state and Warning events. Operator-only. */
  readonly details: readonly string[];
}

const MAX_EVENT_LINES = 3;
const MAX_EVENT_MESSAGE = 300;
const MAX_TEXT = 1000;
/** Reasons already carried by the Job condition. */
const CONDITION_ECHOES = new Set(['DeadlineExceeded', 'BackoffLimitExceeded']);

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `Failed`, else `FailureTarget`, as "Reason: message". Pure. */
export function jobFailureReason(conditions: readonly JobConditionLite[] | undefined): string | null {
  for (const type of ['Failed', 'FailureTarget']) {
    const c = (conditions ?? []).find((x) => x.type === type && x.status === 'True');
    if (!c) continue;
    const parts = [c.reason, c.message].filter((p): p is string => Boolean(p && p.trim()));
    if (parts.length > 0) return parts.join(': ');
  }
  return null;
}

/** One pod's not-running state, or null for a pod that ran and exited 0. Pure. */
export function describeStuckPod(pod: PodLite): string | null {
  const name = pod.metadata?.name ?? '(pod)';
  const node = pod.spec?.nodeName;
  if (!node) {
    const sched = pod.status?.conditions?.find((c) => c.type === 'PodScheduled' && c.status === 'False');
    if (!sched) return pod.status?.phase === 'Pending' ? `pod ${name} was never scheduled` : null;
    const why = [sched.reason, sched.message].filter(Boolean).join(': ');
    return `pod ${name} was never scheduled${why ? ` (${why})` : ''}`;
  }
  for (const cs of pod.status?.containerStatuses ?? []) {
    const waiting = cs.state?.waiting;
    if (waiting?.reason) {
      const detail = waiting.message ? `${waiting.reason}: ${clip(waiting.message, 200)}` : waiting.reason;
      return `pod ${name} on node ${node} never started (${detail})`;
    }
    const term = cs.state?.terminated;
    if (term && term.exitCode !== undefined && term.exitCode !== 0) {
      return `pod ${name} on node ${node}: container exited ${term.exitCode}${term.reason ? ` (${term.reason})` : ''}`;
    }
  }
  if (pod.status?.phase === 'Pending') return `pod ${name} on node ${node} never started`;
  return null;
}

/** Pods the Job controller created, from its "Created pod: <name>" events. Pure. */
export function podNamesFromJobEvents(events: readonly EventLite[], jobName: string): string[] {
  const names = new Set<string>();
  for (const e of events) {
    if (e.involvedObject?.kind !== 'Job' || e.involvedObject.name !== jobName) continue;
    const m = /^Created pod: (\S+)$/.exec(e.message ?? '');
    if (m) names.add(m[1]!);
  }
  return [...names];
}

function eventTimeMs(e: EventLite): number {
  const t = e.lastTimestamp ?? e.eventTime;
  const ms = t instanceof Date ? t.getTime() : typeof t === 'string' ? Date.parse(t) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Warning events about the Job and its pods — one line per reason, ordered by
 * when that reason was last seen, earliest first (the first cause usually
 * explains the rest). Pure.
 */
export function summariseWarningEvents(
  events: readonly EventLite[],
  jobName: string,
  podNames: ReadonlySet<string>,
): string[] {
  const latest = new Map<string, EventLite>();
  for (const e of events) {
    if (e.type !== 'Warning' || !e.reason || !e.message) continue;
    const obj = e.involvedObject;
    const ours = (obj?.kind === 'Pod' && podNames.has(obj.name ?? ''))
      || (obj?.kind === 'Job' && obj.name === jobName);
    if (!ours || CONDITION_ECHOES.has(e.reason)) continue;
    const prev = latest.get(e.reason);
    if (!prev || eventTimeMs(e) >= eventTimeMs(prev)) latest.set(e.reason, e);
  }
  return [...latest.values()]
    .sort((a, b) => eventTimeMs(a) - eventTimeMs(b))
    .slice(0, MAX_EVENT_LINES)
    .map((e) => `${e.reason}: ${clip(e.message!.trim(), MAX_EVENT_MESSAGE)}`);
}

async function listOrEmpty(read: () => Promise<{ items?: unknown[] }>): Promise<unknown[]> {
  try {
    return (await read()).items ?? [];
  } catch {
    return [];
  }
}

/**
 * The failure reason plus whatever the cluster still knows about the pod.
 * Falls back to "Job failed" when nothing says why. Never throws.
 */
export async function describeJobFailure(
  core: JobFailureCore,
  namespace: string,
  jobName: string,
  conditions: readonly JobConditionLite[] | undefined,
): Promise<JobFailureDescription> {
  const [pods, jobEvents, warnings] = await Promise.all([
    listOrEmpty(() => core.listNamespacedPod({ namespace, labelSelector: `job-name=${jobName}` })),
    listOrEmpty(() => core.listNamespacedEvent({
      namespace,
      fieldSelector: `involvedObject.kind=Job,involvedObject.name=${jobName}`,
    })),
    listOrEmpty(() => core.listNamespacedEvent({ namespace, fieldSelector: 'type=Warning' })),
  ]);

  const livePods = pods as PodLite[];
  const podNames = new Set([
    ...podNamesFromJobEvents(jobEvents as EventLite[], jobName),
    ...livePods.map((p) => p.metadata?.name).filter((n): n is string => Boolean(n)),
  ]);

  return {
    reason: jobFailureReason(conditions) ?? 'Job failed',
    details: [
      ...livePods.map(describeStuckPod).filter((s): s is string => s !== null),
      ...summariseWarningEvents(warnings as EventLite[], jobName, podNames),
    ],
  };
}

/**
 * "<reason>; diagnosis: <details>" — the details (plus any the caller adds,
 * such as where it pinned the pod) behind the operator-only marker. Pure.
 */
export function formatJobFailure(d: JobFailureDescription, extraDetails: readonly string[]): string {
  const details = [...d.details, ...extraDetails];
  if (details.length === 0) return d.reason;
  return clip(`${d.reason}${DIAGNOSIS_MARKER} ${details.join('; ')}`, MAX_TEXT);
}

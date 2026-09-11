/**
 * Phase 1d — per-tenant OOM-kill detection (resource monitoring, 2026-07).
 *
 * The platform already detects OOMKilled for *deployment status* (marks a
 * deployment failed), but nothing alerted an admin when a tenant's container was
 * OOM-killed. This scans a tenant namespace's pod container statuses for the
 * kernel OOM killer and returns the events so the metrics-scheduler can fire an
 * admin alert.
 *
 * Runs off the SAME hourly per-tenant loop as saturation — no extra scheduler,
 * no time-series. Deduping is the dispatcher's job (keyed on restartCount, so a
 * new kill re-alerts but a still-Running-after-old-kill pod does not).
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { classifyOom, isExpectedSigkill } from '../../lib/container-termination.js';

export interface OomEvent {
  readonly podName: string;
  readonly containerName: string;
  /** Container restart count at scan time — increments on each OOM kill. */
  readonly restartCount: number;
  /** finishedAt of the OOM-terminated state (ISO), or null if kubelet omitted it. */
  readonly at: string | null;
  /**
   * 'confirmed'   — the kubelet reported `OOMKilled`.
   * 'unconfirmed' — inferred from exit 137 alone. Still worth alerting on (it
   *                 is how cgroup group-kills surface) but the alert must SAY
   *                 so rather than asserting an OOM. Three tenants were told
   *                 "apache-php OOM-killed" for a node reboot on 2026-09-11.
   */
  readonly confidence: 'confirmed' | 'unconfirmed';
}

interface ContainerTerminated {
  readonly reason?: string;
  /** Required for the exit-137 arm of classifyOom() to be reachable at all. */
  readonly exitCode?: number;
  readonly finishedAt?: string;
}
interface ContainerStatus {
  readonly name?: string;
  readonly restartCount?: number;
  readonly state?: { readonly terminated?: ContainerTerminated };
  readonly lastState?: { readonly terminated?: ContainerTerminated };
}
interface PodItem {
  readonly metadata?: {
    readonly name?: string;
    readonly labels?: Record<string, string>;
    /** Present once a rollout/scale-down/drain starts deleting the pod. */
    readonly deletionTimestamp?: string;
  };
  readonly status?: {
    /** Pod-level reason — `Terminated`/`NodeShutdown` on a node shutdown. */
    readonly reason?: string;
    readonly containerStatuses?: readonly ContainerStatus[];
  };
}

/** Platform system pods (file-manager, sftp helper, …) don't count as tenant OOMs. */
function isSystemPod(labels: Record<string, string> | undefined): boolean {
  return labels?.['platform.io/system'] === 'true';
}

/**
 * Pure: pod list → recent OOM events. `lookbackMs` filters out stale kills
 * (a pod that OOMed days ago but is now Running still carries lastState until
 * it's recreated); events with no finishedAt are kept (can't date them — the
 * restartCount dedupe stops repeat alerts).
 */
export function extractOomEvents(
  pods: readonly PodItem[],
  nowMs: number,
  lookbackMs: number,
): OomEvent[] {
  const out: OomEvent[] = [];
  for (const pod of pods) {
    const podName = pod.metadata?.name;
    if (!podName) continue;
    if (isSystemPod(pod.metadata?.labels)) continue;
    // A pod the kubelet is shutting down SIGKILLs its containers by design.
    // Computed once per pod: it is a pod-level fact, not a container one.
    const expectedKill = isExpectedSigkill({
      deletionTimestamp: pod.metadata?.deletionTimestamp,
      reason: pod.status?.reason,
    });
    for (const cs of pod.status?.containerStatuses ?? []) {
      const term = cs.lastState?.terminated ?? cs.state?.terminated;
      // Not `reason !== 'OOMKilled'`: the kubelet reports some cgroup OOM
      // group-kills as {exitCode:137, reason:"Error"}, and this scan is the
      // ONLY thing that raises a per-tenant OOM alert — so it silently
      // skipped exactly the kills that node-health was already inferring.
      const kind = term ? classifyOom(term) : null;
      if (!term || !kind) continue;
      // ...but exit 137 on a pod that is shutting down is the shutdown itself.
      // Dropping these is the whole fix for the 2026-09-11 reboot false alarms.
      if (kind === 'inferred' && expectedKill) continue;
      const at = term.finishedAt ?? null;
      if (at) {
        const t = Date.parse(at);
        if (Number.isFinite(t) && nowMs - t > lookbackMs) continue; // stale
      }
      out.push({
        podName,
        containerName: cs.name ?? 'container',
        restartCount: cs.restartCount ?? 0,
        at,
        confidence: kind === 'explicit' ? 'confirmed' : 'unconfirmed',
      });
    }
  }
  return out;
}

const DEFAULT_LOOKBACK_MS = 90 * 60 * 1000; // 90 min > hourly tick (overlap-safe)

/** List a namespace's pods and return recent OOM events. Never throws. */
export async function scanTenantOom(
  k8s: K8sClients,
  namespace: string,
  nowMs: number = Date.now(),
  lookbackMs: number = DEFAULT_LOOKBACK_MS,
): Promise<OomEvent[]> {
  try {
    const podList = await k8s.core.listNamespacedPod({ namespace });
    const items = (podList as { items?: readonly PodItem[] }).items ?? [];
    return extractOomEvents(items, nowMs, lookbackMs);
  } catch {
    return [];
  }
}

/** Wording for the admin alert, split so the subject can stay short. */
export interface OomPhrasing {
  /** Subject fragment. */
  readonly killSummary: string;
  /** Body sentence, including what to do about it. */
  readonly killDetail: string;
}

/**
 * Render an event for an operator. A CONFIRMED kill names the memory limit as
 * the cause because the kubelet established it; an UNCONFIRMED one must not,
 * because exit 137 is 128+SIGKILL from any source. Telling an admin to raise a
 * limit on a container using 13% of it is the failure this wording prevents —
 * see lib/container-termination.ts and node-health/memory-events.ts, which
 * draws the same line for the node-scoped alert.
 */
export function describeOomEvent(e: OomEvent): OomPhrasing {
  if (e.confidence === 'confirmed') {
    return {
      killSummary: 'OOM-killed',
      killDetail: `was OOM-killed at its memory limit (restarts: ${e.restartCount}). `
        + 'Repeated kills usually mean the workload needs a larger memory limit/plan '
        + "or has a leak — check the tenant's Resource Limits and the deployment.",
    };
  }
  return {
    killSummary: 'SIGKILLed (cause unconfirmed)',
    killDetail: `was SIGKILLed (exit 137, restarts: ${e.restartCount}). The cause is `
      + 'UNCONFIRMED — exit 137 is 128+SIGKILL from any source, including a cgroup OOM '
      + 'group-kill, a failed liveness probe or a node drain. Check the container\'s '
      + 'memory.peak against its limit before changing anything.',
  };
}

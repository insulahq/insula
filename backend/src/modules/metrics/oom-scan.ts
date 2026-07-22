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

export interface OomEvent {
  readonly podName: string;
  readonly containerName: string;
  /** Container restart count at scan time — increments on each OOM kill. */
  readonly restartCount: number;
  /** finishedAt of the OOM-terminated state (ISO), or null if kubelet omitted it. */
  readonly at: string | null;
}

interface ContainerTerminated {
  readonly reason?: string;
  readonly finishedAt?: string;
}
interface ContainerStatus {
  readonly name?: string;
  readonly restartCount?: number;
  readonly state?: { readonly terminated?: ContainerTerminated };
  readonly lastState?: { readonly terminated?: ContainerTerminated };
}
interface PodItem {
  readonly metadata?: { readonly name?: string; readonly labels?: Record<string, string> };
  readonly status?: { readonly containerStatuses?: readonly ContainerStatus[] };
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
    for (const cs of pod.status?.containerStatuses ?? []) {
      const term = cs.lastState?.terminated ?? cs.state?.terminated;
      if (term?.reason !== 'OOMKilled') continue;
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

/**
 * Reaping node-reboot debris.
 *
 * A graceful node shutdown leaves two kinds of dead pod OBJECT behind, and
 * nothing in Kubernetes removes them: `--terminated-pod-gc-threshold` defaults
 * to 12500, so they accumulate across reboots for months.
 *
 *   status.reason = "NodeShutdown"   "Pod was rejected as the node is shutting
 *                                     down." The pod NEVER STARTED a container.
 *   status.reason = "Terminated"     "Pod was terminated in response to
 *                                     imminent node shutdown." It ran and was
 *                                     drained.
 *
 * WHY THIS IS WORTH AUTOMATING
 * ----------------------------
 * Production, 2026-09-03: one reboot produced 822 `NodeShutdown` pods in
 * `tigera-operator` alone. The mechanism (see
 * feedback: priority-zero floods) is that a drained pod goes terminal while the
 * node is still Ready and SCHEDULABLE, its ReplicaSet makes a replacement, the
 * scheduler binds the replacement straight back to the draining node because
 * the operator tolerates every taint, and the kubelet rejects it. Repeat for
 * the rest of the drain window.
 *
 * Giving tigera-operator a real priorityClassName (PR #363) moved it into the
 * LAST drain group and cut that to 20 per reboot — measured 2026-09-11 — but
 * not to zero, and 20/reboot still accumulates without bound. The residue is
 * inherent: a Deployment with blanket `operator: Exists` tolerations will
 * always get a few replacements bound to a node that is draining but has not
 * yet stopped heartbeating. Kubelet does not cordon a node it is shutting down.
 *
 * These records are not inert. They are pod objects with exit-code-137
 * container statuses, and they are precisely what made the OOM detectors report
 * five reboot corpses as tenant OOM kills on 2026-09-11.
 *
 * SAFETY
 * ------
 * Only pods that are (a) in terminal phase `Failed`, (b) stamped by the kubelet
 * with a node-shutdown reason, (c) owned by a controller that has therefore
 * already replaced them, and (d) older than a grace window that keeps them
 * visible for post-reboot diagnosis. A Running pod, a bare (unowned) pod and a
 * CNPG instance pod are never selected. This is strictly narrower than the
 * operator-facing "clean stale pod records" action in recovery.ts, which also
 * takes plain Failed/Evicted pods but only in allow-listed namespaces.
 *
 * Unlike that action this one DOES cover `tenant-*` namespaces: a node-shutdown
 * record there is the same disposable object, its Deployment has already made
 * the replacement, and leaving it is what poisoned the per-tenant OOM alerts.
 */

import { NODE_SHUTDOWN_POD_REASONS } from '../../lib/container-termination.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/**
 * Keep debris around this long before reaping it, so an operator looking at the
 * cluster right after a reboot still sees what the shutdown killed. One reboot
 * cycle is minutes; this is comfortably longer and still far short of the next.
 */
export const DEBRIS_GRACE_MS = 30 * 60 * 1000;

export interface DebrisPod {
  readonly metadata?: {
    readonly name?: string;
    readonly namespace?: string;
    readonly creationTimestamp?: string;
    readonly deletionTimestamp?: string;
    readonly ownerReferences?: ReadonlyArray<{ readonly controller?: boolean }>;
    readonly labels?: Record<string, string>;
  };
  readonly status?: {
    readonly phase?: string;
    readonly reason?: string;
  };
}

export interface DebrisTarget {
  readonly namespace: string;
  readonly name: string;
}

/** CNPG Postgres instance pods are never disposable records. Mirrors recovery.ts. */
function isCnpgInstance(pod: DebrisPod): boolean {
  const l = pod.metadata?.labels ?? {};
  return Boolean(l['cnpg.io/instanceName'] ?? l['cnpg.io/cluster']);
}

/**
 * Pure: pod list → the reboot debris safe to delete. Unit tested directly.
 *
 * `nowMs` and `graceMs` are injected so the age rule is testable without
 * touching the clock.
 */
export function selectShutdownDebris(
  pods: ReadonlyArray<DebrisPod>,
  nowMs: number,
  graceMs: number = DEBRIS_GRACE_MS,
): DebrisTarget[] {
  const out: DebrisTarget[] = [];
  for (const pod of pods) {
    const name = pod.metadata?.name;
    const namespace = pod.metadata?.namespace;
    if (!name || !namespace) continue;

    // Already on its way out — let the API server finish.
    if (pod.metadata?.deletionTimestamp) continue;

    // Terminal phase only. Never a Running/Pending/Succeeded pod.
    if (pod.status?.phase !== 'Failed') continue;

    // The kubelet's own attribution. Anything else (Evicted, a crashed Job)
    // is NOT reboot debris and is left to the operator-facing action.
    const reason = pod.status?.reason;
    if (!reason || !NODE_SHUTDOWN_POD_REASONS.includes(reason)) continue;

    // Owned by a controller ⇒ a replacement already exists. A bare pod has no
    // replacement and deleting it would destroy the only record of it.
    const owned = (pod.metadata?.ownerReferences ?? []).some((o) => o.controller);
    if (!owned) continue;

    if (isCnpgInstance(pod)) continue;

    // Age guard — keep the immediate post-reboot picture intact.
    const created = pod.metadata?.creationTimestamp
      ? Date.parse(pod.metadata.creationTimestamp)
      : NaN;
    if (!Number.isFinite(created) || nowMs - created < graceMs) continue;

    out.push({ namespace, name });
  }
  return out;
}

/**
 * Delete the selected debris. Never throws — this runs inside the node-health
 * tick and a failed cleanup must not fail the reconcile.
 *
 * Returns the number actually deleted (404s are a race, not a failure).
 */
export async function reapShutdownDebris(
  k8s: K8sClients,
  pods: ReadonlyArray<DebrisPod>,
  nowMs: number,
  graceMs: number = DEBRIS_GRACE_MS,
): Promise<number> {
  const targets = selectShutdownDebris(pods, nowMs, graceMs);
  let deleted = 0;
  for (const t of targets) {
    try {
      await k8s.core.deleteNamespacedPod({
        namespace: t.namespace,
        name: t.name,
        gracePeriodSeconds: 0,
      } as unknown as Parameters<typeof k8s.core.deleteNamespacedPod>[0]);
      deleted += 1;
    } catch (err: unknown) {
      const status = (err as { statusCode?: number; code?: number }).statusCode
        ?? (err as { code?: number }).code;
      if (status === 404) continue; // already gone
      console.warn(
        `[node-health] failed to reap shutdown debris ${t.namespace}/${t.name}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (deleted > 0) {
    console.log(`[node-health] reaped ${deleted} node-shutdown pod record(s)`);
  }
  return deleted;
}

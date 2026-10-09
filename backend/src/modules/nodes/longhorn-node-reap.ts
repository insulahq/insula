/**
 * Longhorn keeps its own Node objects (nodes.longhorn.io). Removing a node from
 * Kubernetes — the admin panel's Delete, or a node that is simply gone — leaves its
 * Longhorn node behind: NotReady forever, listed by Longhorn as a host that no longer
 * exists.
 *
 * Longhorn's validating webhook deletes one only when ALL of these hold:
 *   - its Ready condition is not True, with reason KubernetesNodeGone or
 *     ManagerPodMissing (Longhorn itself has seen the node go);
 *   - spec.allowScheduling is false;
 *   - no replica and no engine is on it.
 *
 * Longhorn's own controller retries that delete once the Kubernetes node is gone, so
 * the one condition nothing ever met was scheduling: no step of the platform's node
 * removal turns it off. Measured on the local VM lab removing a worker: the Longhorn
 * node sat NotReady for good; turning scheduling off had Longhorn delete it within
 * seconds.
 *
 * The admin panel's Delete runs while the host is still up (the panel says the host
 * stays running), so at that moment Longhorn still sees a Ready node. The removal is
 * finished here instead, by the node-sync reconciler, once Longhorn has seen the node
 * go: scheduling off, then an explicit delete (not left to Longhorn's retry backoff).
 *
 * One more trap: the webhook refuses EVERY update to a node whose disk status does not
 * match its disk spec ("spec and status of disks … are being syncing"). The node's own
 * Longhorn manager fills that status — so a node removed before it ever did (measured:
 * a worker removed a minute after joining) can never have scheduling turned off, and so
 * can never be deleted. The webhook does not cover the status subresource, and with the
 * node and its manager gone nothing else writes that status: the disk status is aligned
 * with the spec there first.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import { httpStatusOf } from '../../shared/k8s-errors.js';

const LONGHORN = { group: 'longhorn.io', version: 'v1beta2', namespace: 'longhorn-system' } as const;

/** Ready-condition reasons by which Longhorn says the node is gone. */
export const LONGHORN_NODE_GONE_REASONS: readonly string[] = ['KubernetesNodeGone', 'ManagerPodMissing'];

export interface LonghornNodeShape {
  readonly metadata?: { readonly name?: string };
  readonly spec?: { readonly allowScheduling?: boolean; readonly disks?: Readonly<Record<string, unknown>> };
  readonly status?: {
    readonly conditions?: ReadonlyArray<{ readonly type?: string; readonly status?: string; readonly reason?: string }>;
    readonly diskStatus?: Readonly<Record<string, unknown>> | null;
  };
}

/** A replica or an engine: what pins a Longhorn node in place. */
interface PlacedOnNode {
  readonly spec?: { readonly nodeID?: string };
}

export interface ReapCandidate {
  readonly name: string;
  /** spec.allowScheduling before the reap — restored if Longhorn refuses. */
  readonly allowScheduling: boolean;
  /**
   * The status.diskStatus merge patch that makes it match spec.disks (an entry for
   * every spec disk, none for any other), or null when they already match — the
   * webhook refuses any update until they do.
   */
  readonly diskStatusFix: Readonly<Record<string, Record<string, never> | null>> | null;
}

/** The merge patch aligning status.diskStatus with spec.disks; null when aligned. */
export function diskStatusFixFor(node: LonghornNodeShape): Record<string, Record<string, never> | null> | null {
  const specDisks = Object.keys(node.spec?.disks ?? {});
  const statusDisks = Object.keys(node.status?.diskStatus ?? {});
  const fix: Record<string, Record<string, never> | null> = {};
  for (const d of specDisks) if (!statusDisks.includes(d)) fix[d] = {};
  for (const d of statusDisks) if (!specDisks.includes(d)) fix[d] = null;
  return Object.keys(fix).length > 0 ? fix : null;
}

/**
 * The Longhorn nodes that are residue: no Kubernetes node of that name in a
 * SUCCESSFUL, NON-EMPTY node list, Longhorn agreeing that the node is gone, and no
 * replica or engine left on it. An empty node list is an API anomaly, never "every
 * node left" — nothing is planned from it.
 */
export function planLonghornNodeReap(
  longhornNodes: readonly LonghornNodeShape[],
  liveNodeNames: ReadonlySet<string>,
  occupiedNodeIds: ReadonlySet<string>,
): ReapCandidate[] {
  if (liveNodeNames.size === 0) return [];
  const out: ReapCandidate[] = [];
  for (const node of longhornNodes) {
    const name = node.metadata?.name;
    if (!name || liveNodeNames.has(name) || occupiedNodeIds.has(name)) continue;
    const ready = (node.status?.conditions ?? []).find((c) => c.type === 'Ready');
    if (!ready || ready.status === 'True') continue;
    if (!LONGHORN_NODE_GONE_REASONS.includes(ready.reason ?? '')) continue;
    out.push({ name, allowScheduling: node.spec?.allowScheduling !== false, diskStatusFix: diskStatusFixFor(node) });
  }
  return out;
}

export type ReapOutcome = 'deleted' | 'absent' | 'refused';

type CustomApi = {
  patchNamespacedCustomObjectStatus: (
    req: { group: string; version: string; namespace: string; plural: string; name: string; body: unknown },
    mw: typeof MERGE_PATCH,
  ) => Promise<unknown>;
  patchNamespacedCustomObject: (
    req: { group: string; version: string; namespace: string; plural: string; name: string; body: unknown },
    mw: typeof MERGE_PATCH,
  ) => Promise<unknown>;
  deleteNamespacedCustomObject: (
    req: { group: string; version: string; namespace: string; plural: string; name: string },
  ) => Promise<unknown>;
  listNamespacedCustomObject: (
    req: { group: string; version: string; namespace: string; plural: string },
  ) => Promise<unknown>;
};

function custom(k8s: K8sClients): CustomApi {
  return k8s.custom as unknown as CustomApi;
}

async function setAllowScheduling(k8s: K8sClients, name: string, value: boolean): Promise<void> {
  await custom(k8s).patchNamespacedCustomObject(
    { ...LONGHORN, plural: 'nodes', name, body: { spec: { allowScheduling: value } } },
    MERGE_PATCH,
  );
}

/**
 * Delete one Longhorn node: its disk status aligned when it never synced (see the
 * header), scheduling off (the webhook requires it), then the delete — which may find
 * Longhorn's own controller already did it (404: deleted all the same). A refusal (422
 * — something landed on the node after the plan) restores scheduling as it was.
 */
export async function reapLonghornNode(k8s: K8sClients, candidate: ReapCandidate): Promise<ReapOutcome> {
  const { name, allowScheduling, diskStatusFix } = candidate;
  try {
    if (diskStatusFix) {
      await custom(k8s).patchNamespacedCustomObjectStatus(
        { ...LONGHORN, plural: 'nodes', name, body: { status: { diskStatus: diskStatusFix } } },
        MERGE_PATCH,
      );
    }
    if (allowScheduling) await setAllowScheduling(k8s, name, false);
  } catch (err) {
    if (httpStatusOf(err) === 404) return 'absent';
    throw err;
  }
  try {
    await custom(k8s).deleteNamespacedCustomObject({ ...LONGHORN, plural: 'nodes', name });
    return 'deleted';
  } catch (err) {
    const status = httpStatusOf(err);
    if (status === 404) return 'deleted';
    if (allowScheduling) {
      await setAllowScheduling(k8s, name, true).catch((restoreErr: unknown) =>
        console.warn(`[node-sync] could not restore scheduling on Longhorn node ${name}:`, (restoreErr as Error).message));
    }
    if (status === 422) return 'refused';
    throw err;
  }
}

/** Items of a Longhorn resource; null when Longhorn is not installed (404). */
async function listLonghorn<T>(k8s: K8sClients, plural: string): Promise<T[] | null> {
  try {
    const res = (await custom(k8s).listNamespacedCustomObject({ ...LONGHORN, plural })) as { items?: T[] };
    return res.items ?? [];
  } catch (err) {
    if (httpStatusOf(err) === 404) return null;
    throw err;
  }
}

/**
 * Is the Kubernetes node absent right now? The pass plans from the Node list read at the
 * start of the sync tick; a node re-joining under the same name since then must not be
 * reaped on that stale view. Anything but a clear 404 counts as present.
 */
async function kubeNodeGone(k8s: K8sClients, name: string): Promise<boolean> {
  try {
    await k8s.core.readNode({ name });
    return false;
  } catch (err) {
    return httpStatusOf(err) === 404;
  }
}

/**
 * One reconciler pass: remove every residual Longhorn node. `liveNodeNames` must come
 * from a successful Node list. Best-effort — logs, never throws (Longhorn may not be
 * installed yet). Returns the names removed.
 */
export async function reapOrphanLonghornNodes(
  k8s: K8sClients,
  liveNodeNames: readonly string[],
): Promise<string[]> {
  try {
    const live = new Set(liveNodeNames);
    const nodes = await listLonghorn<LonghornNodeShape>(k8s, 'nodes');
    // Steady state: every Longhorn node is a live node — no replica/engine listing.
    if (!nodes || nodes.every((n) => live.has(n.metadata?.name ?? ''))) return [];
    const [replicas, engines] = await Promise.all([
      listLonghorn<PlacedOnNode>(k8s, 'replicas'),
      listLonghorn<PlacedOnNode>(k8s, 'engines'),
    ]);
    if (replicas === null || engines === null) return [];
    const occupied = new Set(
      [...replicas, ...engines].map((o) => o.spec?.nodeID).filter((id): id is string => Boolean(id)),
    );
    const removed: string[] = [];
    for (const candidate of planLonghornNodeReap(nodes, live, occupied)) {
      if (!(await kubeNodeGone(k8s, candidate.name))) continue;
      const outcome = await reapLonghornNode(k8s, candidate);
      if (outcome === 'deleted') {
        removed.push(candidate.name);
        console.info(`[node-sync] removed Longhorn node ${candidate.name} — its Kubernetes node is gone`);
      } else if (outcome === 'refused') {
        console.warn(`[node-sync] Longhorn refused to remove node ${candidate.name}; scheduling restored, retrying next tick`);
      }
    }
    return removed;
  } catch (err) {
    console.warn('[node-sync] Longhorn node cleanup failed:', (err as Error).message);
    return [];
  }
}

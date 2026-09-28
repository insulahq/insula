/**
 * Cluster-wide workload snapshot — one pair of LIST calls that replaces the
 * per-deployment, per-component API fan-out the status reconciler used to do.
 *
 * ## Why this exists
 *
 * `getK8sDeploymentStatus` reads two objects per component: the Deployment and
 * the component's pods. The status reconciler calls it for every component of
 * every active deployment, every 15s. On the production cluster that was ~82
 * API requests per tick (36 catalog deployments, mostly single-component).
 *
 * That would be unremarkable if the client pooled connections. It does not:
 * `@kubernetes/client-node` builds a fresh `https.Agent` inside
 * `applyToHTTPSOptions` on EVERY request (config.js — `opts.agent =
 * this.createAgent(...)`), and `new https.Agent()` defaults to
 * `keepAlive: false` on Node 22. So each request is its own TCP + TLS
 * handshake, and the socket is torn down after it. Measured on production:
 * platform-api's open-socket count sawtoothed from ~12 to ~170 and back on a
 * precise 15-second period — ~6.7 TLS handshakes per second, sustained, paid
 * for twice (once in platform-api, once in the k3s apiserver).
 *
 * Reusing the client object does NOT fix this — the agent is per-request, not
 * per-client — and `createAgent` is `private` in the published typings, so
 * overriding it is not a supported extension point. The only safe lever is to
 * issue FEWER requests. This module is that lever: two cluster-wide LISTs per
 * tick instead of ~82 namespaced reads.
 *
 * ## Why a snapshot rather than a watch/informer
 *
 * An informer would be fewer requests still, but it is a much larger change:
 * it holds long-lived connections, needs resync/error handling, and changes
 * the reconciler from pull to push. A snapshot keeps the existing control flow
 * and failure semantics exactly, which is what makes it verifiable. Swapping
 * in informers later remains open.
 *
 * ## Consistency
 *
 * A snapshot is strictly MORE consistent than the code it replaces: every
 * component is now judged against one point in time, where before the reads
 * were smeared across the several seconds a tick took to walk its deployments.
 *
 * ## One ordering assumption, and why it holds
 *
 * `getK8sDeploymentStatus` takes the host node from the FIRST live pod, so the
 * snapshot path is only equivalent if grouping a cluster-wide pod list by
 * namespace yields the same per-namespace order a namespaced list would.
 *
 * The List API contract does not promise an order in so many words, but both
 * calls are etcd range scans over `/registry/pods/<namespace>/<name>`, so both
 * come back sorted by name within a namespace. Verified against the live
 * production cluster: a 12-pod namespace listed identically namespace-scoped
 * and filtered out of an all-namespaces list. The bucketing below is a single
 * order-preserving pass, so it carries that order through.
 *
 * Note this is an assumption the per-call path already made — it too took
 * whatever order the apiserver returned. Nothing here made it weaker.
 *
 * The snapshot is a plain read model — callers must treat it as immutable.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/** The Deployment fields `getK8sDeploymentStatus` actually reads. */
export interface SnapshotDeployment {
  readonly spec?: { readonly replicas?: number };
  readonly status?: { readonly replicas?: number; readonly readyReplicas?: number };
}

/**
 * The Pod fields `getK8sDeploymentStatus` actually reads.
 *
 * `metadata.deletionTimestamp` + `status.reason` are what tell a live pod from
 * a dead record — dropping them compiles fine and silently restores the
 * node-reboot false positive (three healthy 1/1 production tenants reported as
 * "Workload ran out of memory", reading corpses that exited 137 at a node
 * shutdown). See `lib/container-termination.ts:isReplacedPodRecord`.
 *
 * `metadata.labels` is present here but absent from the equivalent per-call
 * type: the apiserver used to do the `app=<baseName>` filtering via
 * `labelSelector`, and that filtering now happens in-process instead.
 */
export interface SnapshotPod {
  readonly metadata?: {
    readonly deletionTimestamp?: string;
    readonly labels?: Record<string, string>;
  };
  readonly spec?: { readonly nodeName?: string };
  readonly status?: {
    readonly phase?: string;
    readonly reason?: string;
    readonly conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
    readonly containerStatuses?: Array<{
      state?: {
        waiting?: { reason?: string; message?: string };
        terminated?: { reason?: string; message?: string; exitCode?: number };
      };
    }>;
  };
}

export interface WorkloadSnapshot {
  /** Deployments keyed `<namespace>/<name>`. Absent key ⇒ the 404 path. */
  readonly deployments: ReadonlyMap<string, SnapshotDeployment>;
  /** Pods grouped by namespace, unfiltered — callers apply the label match. */
  readonly podsByNamespace: ReadonlyMap<string, readonly SnapshotPod[]>;
}

/** Key a Deployment the way {@link WorkloadSnapshot.deployments} is indexed. */
export function deploymentKey(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

/**
 * Select a namespace's pods carrying `app=<baseName>`.
 *
 * Equivalent to the `labelSelector: app=<baseName>` the per-call path sent to
 * the apiserver — an equality match on one label, nothing more. A namespace
 * with no pods yields an empty array, matching an empty `items` list.
 */
export function podsForApp(
  snapshot: WorkloadSnapshot,
  namespace: string,
  baseName: string,
): readonly SnapshotPod[] {
  const pods = snapshot.podsByNamespace.get(namespace);
  if (!pods) return [];
  return pods.filter((p) => p.metadata?.labels?.app === baseName);
}

type ListedDeployment = SnapshotDeployment & {
  metadata?: { name?: string; namespace?: string };
};
type ListedPod = SnapshotPod & { metadata?: { namespace?: string } };

/**
 * Read every Deployment and Pod in the cluster in two requests.
 *
 * Both lists are cluster-scoped, which the platform ClusterRole already
 * permits (`apps/deployments: ["*"]`, `pods: ["*"]` — and
 * `dashboard/cpu-reservation.ts` already does the pod half).
 *
 * Throws if either LIST fails. Callers are expected to fall back to the
 * per-call path rather than skipping a reconcile cycle — a snapshot is an
 * optimisation, never a precondition.
 */
export async function buildWorkloadSnapshot(k8s: K8sClients): Promise<WorkloadSnapshot> {
  const [deployRes, podRes] = await Promise.all([
    k8s.apps.listDeploymentForAllNamespaces(),
    k8s.core.listPodForAllNamespaces(),
  ]);

  const deployments = new Map<string, SnapshotDeployment>();
  for (const d of ((deployRes as { items?: ListedDeployment[] }).items ?? [])) {
    const name = d.metadata?.name;
    const namespace = d.metadata?.namespace;
    // A Deployment with no name/namespace cannot be looked up, so indexing it
    // would only produce an unreachable entry.
    if (!name || !namespace) continue;
    deployments.set(deploymentKey(namespace, name), d);
  }

  const podsByNamespace = new Map<string, SnapshotPod[]>();
  for (const p of ((podRes as { items?: ListedPod[] }).items ?? [])) {
    const namespace = p.metadata?.namespace;
    if (!namespace) continue;
    const bucket = podsByNamespace.get(namespace);
    if (bucket) bucket.push(p);
    else podsByNamespace.set(namespace, [p]);
  }

  return { deployments, podsByNamespace };
}

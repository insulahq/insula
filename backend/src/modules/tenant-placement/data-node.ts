/**
 * Which node holds a tenant's data — the one place a pod that mounts the
 * tenant PVC should run.
 *
 * Longhorn's `dataLocality: best-effort` makes the data FOLLOW the pod: when a
 * pod mounting a single-replica volume starts on another node, Longhorn builds
 * a replica there and deletes the old one — a full-volume copy between nodes.
 * So any platform pod that mounts a tenant PVC (backup capture, file manager)
 * and is left to the scheduler can silently move the tenant's data. Measured
 * on production: four stopped tenants' volumes moved to the second node
 * because their nightly backup pods were scheduled there.
 *
 * Order, first hit wins:
 *   1. attached — the node Longhorn reports the volume ATTACHED to. An RWO
 *                 volume can be mounted there and nowhere else, so this is the
 *                 storage layer's own answer, not an inference from pods.
 *   2. mounted  — the node of a Running, not-terminating pod that mounts the
 *                 PVC; used when the Longhorn Volume could not be read. Running
 *                 means its volumes are mounted. A PENDING pod is not evidence:
 *                 it can be bound to a node the volume will never attach to.
 *                 That is what failed a production backup — a file manager
 *                 pinned to the wrong node sat Pending on Multi-Attach, listed
 *                 before the app pods, and the capture Job was pinned beside it
 *                 until its deadline expired.
 *   3. replica  — a node holding a healthy Longhorn replica. The tenant's
 *                 primary node when it is one of them, else the first by name
 *                 (deterministic; every replica node holds the data).
 *   4. pin      — the tenant's primary node (`tenants.node_name`), when
 *                 Longhorn could not be read.
 * Null when none is known: the caller leaves the pod unpinned, as before.
 */
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export type DataNodeSource = 'attached' | 'mounted' | 'replica' | 'pin';

export interface DataNodeChoice {
  readonly node: string | null;
  readonly source: DataNodeSource | null;
}

export interface DataNodeInputs {
  /** Where Longhorn has the volume attached. */
  readonly attachedNode: string | null;
  /** Where a Running pod mounts the PVC. */
  readonly mountedNode: string | null;
  readonly replicaNodes: readonly string[];
  readonly pinNode: string | null;
}

const NODE_NAME_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i;

/** A node name we are willing to put into a pod spec. */
export function isNodeName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 253 && NODE_NAME_RE.test(value);
}

/** Pure — see the module header for the order. */
export function chooseDataNode(input: DataNodeInputs): DataNodeChoice {
  if (isNodeName(input.attachedNode)) return { node: input.attachedNode, source: 'attached' };
  if (isNodeName(input.mountedNode)) return { node: input.mountedNode, source: 'mounted' };
  const replicas = [...new Set(input.replicaNodes.filter(isNodeName))].sort();
  if (replicas.length > 0) {
    const preferred = input.pinNode && replicas.includes(input.pinNode) ? input.pinNode : replicas[0]!;
    return { node: preferred, source: 'replica' };
  }
  if (isNodeName(input.pinNode)) return { node: input.pinNode, source: 'pin' };
  return { node: null, source: null };
}

interface PodLike {
  readonly status?: { readonly phase?: string };
  readonly metadata?: { readonly deletionTimestamp?: unknown };
  readonly spec?: {
    readonly nodeName?: string;
    readonly volumes?: ReadonlyArray<{ readonly persistentVolumeClaim?: { readonly claimName?: string } }>;
  };
}

/** Node of a Running, not-terminating pod that mounts `pvcName`, or null. */
export async function findNodeMountingPvc(
  k8s: Pick<K8sClients, 'core'>,
  namespace: string,
  pvcName: string,
): Promise<string | null> {
  const res = await k8s.core.listNamespacedPod({ namespace });
  for (const pod of (res.items ?? []) as PodLike[]) {
    if (pod.status?.phase !== 'Running') continue;
    if (pod.metadata?.deletionTimestamp) continue;
    const mounts = (pod.spec?.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === pvcName);
    if (mounts && isNodeName(pod.spec?.nodeName)) return pod.spec!.nodeName!;
  }
  return null;
}

interface VolumeLike {
  readonly status?: { readonly state?: string; readonly currentNodeID?: string };
}

/**
 * The node a Longhorn Volume is attached to, or null. Pure.
 *
 * Only `attached` counts: a detached volume keeps an empty `currentNodeID`, and
 * an `attaching` one cannot be mounted anywhere yet.
 */
export function attachedNodeOf(volume: VolumeLike): string | null {
  if (volume.status?.state !== 'attached') return null;
  const node = volume.status.currentNodeID;
  return isNodeName(node) ? node : null;
}

/** The node the Longhorn volume `volumeName` is attached to, or null. */
export async function readVolumeAttachedNode(
  k8s: Pick<K8sClients, 'custom'>,
  volumeName: string,
): Promise<string | null> {
  const volume = await k8s.custom.getNamespacedCustomObject({
    group: 'longhorn.io',
    version: 'v1beta2',
    namespace: 'longhorn-system',
    plural: 'volumes',
    name: volumeName,
  } as unknown as Parameters<K8sClients['custom']['getNamespacedCustomObject']>[0]);
  return attachedNodeOf(volume as VolumeLike);
}

interface ReplicaLike {
  readonly spec?: { readonly nodeID?: string; readonly failedAt?: string; readonly volumeName?: string };
  readonly status?: { readonly currentState?: string };
}

/** Nodes holding a usable replica, from Longhorn Replica CRs. Pure. */
export function usableReplicaNodes(replicas: readonly ReplicaLike[]): string[] {
  const nodes = new Set<string>();
  for (const r of replicas) {
    // A replica Longhorn marked failed is not where the data is any more —
    // it is the copy that is about to be rebuilt elsewhere.
    if (r.spec?.failedAt) continue;
    if (r.status?.currentState === 'error') continue;
    if (isNodeName(r.spec?.nodeID)) nodes.add(r.spec!.nodeID!);
  }
  return [...nodes].sort();
}

/** The Longhorn volume (= PV) name bound to a PVC, or null. */
export async function readPvcVolumeName(
  k8s: Pick<K8sClients, 'core'>,
  namespace: string,
  pvcName: string,
): Promise<string | null> {
  const pvc = await k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace }) as {
    spec?: { volumeName?: string };
  };
  const name = pvc.spec?.volumeName;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

/** Nodes holding a usable replica of the Longhorn volume `volumeName`. */
export async function readVolumeReplicaNodes(
  k8s: Pick<K8sClients, 'custom'>,
  volumeName: string,
): Promise<string[]> {
  const res = await k8s.custom.listNamespacedCustomObject({
    group: 'longhorn.io',
    version: 'v1beta2',
    namespace: 'longhorn-system',
    plural: 'replicas',
    labelSelector: `longhornvolume=${volumeName}`,
  } as unknown as Parameters<K8sClients['custom']['listNamespacedCustomObject']>[0]);
  return usableReplicaNodes(((res as { items?: ReplicaLike[] }).items ?? []));
}

export interface ResolveDataNodeOptions {
  readonly namespace: string;
  readonly pvcName: string;
  /** The tenant's primary node, when known. */
  readonly pinNode: string | null;
  /**
   * When several replica nodes hold the data and none is the pin, return null
   * instead of picking one. For a long-lived pod (file manager) that should
   * keep the scheduler's freedom on an HA volume; a one-shot Job can take any.
   */
  readonly unambiguousOnly?: boolean;
  readonly logger?: { warn: (msg: string) => void };
}

/**
 * Resolve the data node for a tenant PVC. Never throws — a lookup failure
 * degrades to the next source and, at worst, to null (unpinned, the old
 * behaviour), because a backup or a file-manager start must not fail on a
 * placement hint.
 */
export async function resolveTenantDataNode(
  k8s: Pick<K8sClients, 'core' | 'custom'>,
  opts: ResolveDataNodeOptions,
): Promise<DataNodeChoice> {
  const where = `${opts.namespace}/${opts.pvcName}`;
  let volumeName: string | null = null;
  try {
    volumeName = await readPvcVolumeName(k8s, opts.namespace, opts.pvcName);
  } catch (err) {
    opts.logger?.warn(`data node: PVC lookup for ${where} failed (${(err as Error).message})`);
  }

  if (volumeName) {
    try {
      const attachedNode = await readVolumeAttachedNode(k8s, volumeName);
      if (attachedNode) return { node: attachedNode, source: 'attached' };
    } catch (err) {
      opts.logger?.warn(`data node: Longhorn volume lookup for ${where} failed (${(err as Error).message})`);
    }
  }

  let mountedNode: string | null = null;
  try {
    mountedNode = await findNodeMountingPvc(k8s, opts.namespace, opts.pvcName);
  } catch (err) {
    opts.logger?.warn(`data node: pod lookup in ${opts.namespace} failed (${(err as Error).message})`);
  }
  if (mountedNode) return { node: mountedNode, source: 'mounted' };

  let replicaNodes: string[] = [];
  if (volumeName) {
    try {
      replicaNodes = await readVolumeReplicaNodes(k8s, volumeName);
    } catch (err) {
      opts.logger?.warn(`data node: Longhorn replica lookup for ${where} failed (${(err as Error).message})`);
    }
  }
  if (opts.unambiguousOnly && replicaNodes.length > 1 && !(opts.pinNode && replicaNodes.includes(opts.pinNode))) {
    return { node: null, source: null };
  }
  return chooseDataNode({ attachedNode: null, mountedNode: null, replicaNodes, pinNode: opts.pinNode });
}

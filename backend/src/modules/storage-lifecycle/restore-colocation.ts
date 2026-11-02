/**
 * Before a restore scales a tenant back up, put the workloads that share its
 * volume on one node.
 *
 * A tenant's Deployments share ONE ReadWriteOnce volume, so they run together
 * on one node or not at all. A pinned tenant's carry the pin; an Auto
 * tenant's carry the data node (tenant-placement/pod-placement.ts). One that
 * carries nothing — a pin cleared by an older re-pin to Auto, a render that
 * lost it — is placed by the scheduler on its own. Production: the auto-heal
 * scaled such a tenant up, its web pods started on the node that took the
 * volume, its database on another, and the heal failed waiting for the
 * database while the CRM on it answered 500.
 *
 * So, while it is not running yet, every UNPINNED Deployment the restore is
 * about to start that mounts the tenant's claim gets the node the others are
 * pinned to — or, when none is pinned, the node holding the data (attached,
 * else its one replica), if that node takes pods: a pin to a cordoned, tainted
 * or NotReady node would never start. Only for a single-copy volume when
 * nothing is pinned: an HA volume is not held to one node here. A workload
 * pinned to a node is never moved (two pins that disagree are the operator's
 * to settle), one that is running is never restarted, one the restore leaves
 * stopped is not touched, and nothing here throws: a failure leaves the
 * restore as it was.
 */
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import { STORAGE_PREQUIESCE_REPLICAS_ANNOTATION, STORAGE_QUIESCED_ANNOTATION } from '../../shared/scale-deployment.js';
import { readPvcVolumeName, resolveTenantDataNode } from '../tenant-placement/data-node.js';
import { HOSTNAME_LABEL } from '../tenant-placement/pod-placement.js';
import { hostnamePinOf, type PodTemplateSpecLike } from '../tenant-placement/workload-pin.js';

export interface RestoreWorkload {
  readonly name: string;
  /** Its hostname pin (nodeSelector or required affinity), or null. */
  readonly pin: string | null;
  /** Mounts the tenant's claim — the volume that holds the workloads together. */
  readonly mountsData: boolean;
  /** Wants pods and has them all available: changing it would restart it. */
  readonly running: boolean;
}

export interface RestoreColocationPlan {
  readonly node: string | null;
  /** Deployments to pin to `node` before the scale-up. */
  readonly patch: readonly string[];
}

const NO_PLAN: RestoreColocationPlan = { node: null, patch: [] };

/**
 * Pure. `dataNode` is consulted only when no workload sharing the volume is
 * pinned; null there (unknown, or an HA volume) leaves everything as it is.
 */
export function planRestoreColocation(
  workloads: readonly RestoreWorkload[],
  dataNode: string | null,
): RestoreColocationPlan {
  const sharing = workloads.filter((w) => w.mountsData);
  const pins = [...new Set(sharing.flatMap((w) => (w.pin ? [w.pin] : [])))];
  if (pins.length > 1) return NO_PLAN;
  const node = pins[0] ?? dataNode;
  if (!node) return NO_PLAN;
  const patch = sharing.filter((w) => w.pin === null && !w.running).map((w) => w.name);
  return patch.length > 0 ? { node, patch } : NO_PLAN;
}

interface DeploymentLike {
  readonly metadata?: { readonly name?: string; readonly annotations?: Readonly<Record<string, string>> };
  readonly spec?: {
    readonly replicas?: number;
    readonly template?: {
      readonly spec?: PodTemplateSpecLike & {
        readonly volumes?: ReadonlyArray<{ readonly persistentVolumeClaim?: { readonly claimName?: string } }>;
      };
    };
  };
  readonly status?: { readonly availableReplicas?: number };
}

/** The restore's view of one Deployment. Pure. */
export function restoreWorkloadOf(d: DeploymentLike, claimName: string): RestoreWorkload | null {
  const name = d.metadata?.name;
  if (!name) return null;
  const spec = d.spec?.template?.spec;
  const desired = d.spec?.replicas ?? 1;
  return {
    name,
    pin: hostnamePinOf(spec)?.node ?? null,
    mountsData: (spec?.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === claimName),
    running: desired > 0 && (d.status?.availableReplicas ?? 0) >= desired,
  };
}

/**
 * The Deployments a restore from `entries` scales up: a snapshot count above
 * 0, or 0 while the Deployment is still held with a recorded count — the
 * stale-snapshot case unquiesce restores from the annotation. Pure.
 */
export function deploymentsToStart(
  entries: ReadonlyArray<{ readonly name: string; readonly replicas: number }>,
  live: readonly DeploymentLike[],
): Set<string> {
  const byName = new Map(live.map((d) => [d.metadata?.name ?? '', d]));
  const start = new Set<string>();
  for (const e of entries) {
    if (e.replicas > 0) { start.add(e.name); continue; }
    const ann = byName.get(e.name)?.metadata?.annotations ?? {};
    if (ann[STORAGE_QUIESCED_ANNOTATION] === 'true' && Number(ann[STORAGE_PREQUIESCE_REPLICAS_ANNOTATION]) > 0) {
      start.add(e.name);
    }
  }
  return start;
}

interface NodeLike {
  readonly spec?: { readonly unschedulable?: boolean; readonly taints?: ReadonlyArray<{ readonly effect?: string }> };
  readonly status?: { readonly conditions?: ReadonlyArray<{ readonly type?: string; readonly status?: string }> };
}

/** Ready, not cordoned, and no taint that keeps tenant pods off. Pure. */
export function nodeTakesPods(node: NodeLike): boolean {
  if (node.spec?.unschedulable === true) return false;
  if ((node.spec?.taints ?? []).some((t) => t.effect === 'NoSchedule' || t.effect === 'NoExecute')) return false;
  return (node.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
}

/** True when the Longhorn volume keeps one copy — the Local tier. */
async function isSingleCopyVolume(k8s: Pick<K8sClients, 'core' | 'custom'>, namespace: string, claimName: string): Promise<boolean> {
  const volumeName = await readPvcVolumeName(k8s, namespace, claimName);
  if (!volumeName) return false;
  const volume = await k8s.custom.getNamespacedCustomObject({
    group: 'longhorn.io',
    version: 'v1beta2',
    namespace: 'longhorn-system',
    plural: 'volumes',
    name: volumeName,
  } as unknown as Parameters<K8sClients['custom']['getNamespacedCustomObject']>[0]) as { spec?: { numberOfReplicas?: number } };
  return volume.spec?.numberOfReplicas === 1;
}

/**
 * Pin the restore's unpinned Deployments to the tenant's one node (see the
 * header). `entries` are the restore snapshot's Deployments. Never throws.
 */
export async function colocateBeforeRestore(
  k8s: K8sClients,
  namespace: string,
  entries: ReadonlyArray<{ readonly name: string; readonly replicas: number }>,
): Promise<RestoreColocationPlan> {
  const claimName = `${namespace}-storage`;
  try {
    const list = await k8s.apps.listNamespacedDeployment({ namespace });
    const live = (list.items ?? []) as DeploymentLike[];
    const starting = deploymentsToStart(entries, live);
    const workloads = live
      .filter((d) => starting.has(d.metadata?.name ?? ''))
      .map((d) => restoreWorkloadOf(d, claimName))
      .filter((w): w is RestoreWorkload => w !== null);
    const sharing = workloads.filter((w) => w.mountsData);
    if (!sharing.some((w) => w.pin === null && !w.running)) return NO_PLAN;

    const pins = [...new Set(sharing.flatMap((w) => (w.pin ? [w.pin] : [])))];
    if (pins.length > 1) {
      console.warn(`[unquiesce] ${namespace}: the workloads sharing the volume are pinned to ${pins.join(' and ')}; leaving them as they are`);
      return NO_PLAN;
    }
    let dataNode: string | null = null;
    if (pins.length === 0) {
      // An HA volume keeps copies on several nodes: not held to one here.
      if (!await isSingleCopyVolume(k8s, namespace, claimName)) return NO_PLAN;
      dataNode = (await resolveTenantDataNode(k8s, {
        namespace,
        pvcName: claimName,
        pinNode: null,
        unambiguousOnly: true,
        logger: { warn: (msg) => console.warn(`[unquiesce] ${msg}`) },
      })).node;
      if (!dataNode) {
        console.warn(`[unquiesce] ${namespace}: the node holding the data is not known; the scheduler places the workloads`);
        return NO_PLAN;
      }
      if (!nodeTakesPods(await k8s.core.readNode({ name: dataNode }) as NodeLike)) {
        console.warn(`[unquiesce] ${namespace}: the data is on ${dataNode}, which takes no new pods; the scheduler places the workloads`);
        return NO_PLAN;
      }
    }
    const plan = planRestoreColocation(workloads, dataNode);
    if (!plan.node) return NO_PLAN;
    for (const name of plan.patch) {
      await k8s.apps.patchNamespacedDeployment({
        name,
        namespace,
        body: { spec: { template: { spec: { nodeSelector: { [HOSTNAME_LABEL]: plan.node } } } } },
      } as unknown as Parameters<K8sClients['apps']['patchNamespacedDeployment']>[0], MERGE_PATCH);
    }
    console.info(`[unquiesce] ${namespace}: kept ${plan.patch.join(', ')} with the tenant's data on ${plan.node}`);
    return plan;
  } catch (err) {
    console.warn(`[unquiesce] ${namespace}: could not hold the workloads to one node (${(err as Error).message}); restoring as they are`);
    return NO_PLAN;
  }
}

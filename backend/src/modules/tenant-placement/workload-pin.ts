/**
 * The node a tenant workload is held to by hostname, read from the cluster.
 *
 * `tenants.node_name` is not the whole answer. Auto moves nothing, so a tenant
 * set to Auto while it runs keeps the hostname pin on its Deployments
 * (tenant-migration/unpin.ts), and an Auto tenant's later renders pin its pods
 * to the data node (pod-placement.ts). The row then says "no primary node"
 * while every pod is held to one — and that pin is what a re-pin has to
 * release.
 *
 * Two forms count, the two the drain impact counts (nodes/service.ts
 * detectNodePin): `nodeSelector kubernetes.io/hostname`, and a required
 * node-affinity term `kubernetes.io/hostname In [<one node>]`. A preferred
 * term — an HA tenant's soft preference — holds nothing.
 */
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { isNodeName } from './data-node.js';
import { HOSTNAME_LABEL } from './pod-placement.js';

export interface PodTemplateSpecLike {
  readonly nodeSelector?: Readonly<Record<string, string>>;
  readonly affinity?: {
    readonly nodeAffinity?: {
      readonly requiredDuringSchedulingIgnoredDuringExecution?: {
        readonly nodeSelectorTerms?: ReadonlyArray<{
          readonly matchExpressions?: ReadonlyArray<{
            readonly key?: string;
            readonly operator?: string;
            readonly values?: readonly string[];
          }>;
        }>;
      };
    };
  };
}

export interface HostnamePin {
  readonly node: string;
  readonly kind: 'nodeSelector' | 'nodeAffinity';
}

/** The hostname pin of a pod template, or null. Pure. */
export function hostnamePinOf(spec: PodTemplateSpecLike | undefined): HostnamePin | null {
  const selected = spec?.nodeSelector?.[HOSTNAME_LABEL];
  if (isNodeName(selected)) return { node: selected, kind: 'nodeSelector' };
  const terms = spec?.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms ?? [];
  for (const term of terms) {
    for (const e of term.matchExpressions ?? []) {
      const only = e.values?.length === 1 ? e.values[0] : undefined;
      if (e.key === HOSTNAME_LABEL && e.operator === 'In' && isNodeName(only)) {
        return { node: only, kind: 'nodeAffinity' };
      }
    }
  }
  return null;
}

interface WorkloadLike {
  readonly metadata?: { readonly name?: string };
  readonly spec?: { readonly template?: { readonly spec?: PodTemplateSpecLike } };
}

/** The file manager follows the data when it starts; its pin says nothing about the tenant's. */
const FILE_MANAGER = 'file-manager';

/** Distinct nodes a list of workloads is pinned to, sorted. Pure. */
export function pinNodesOf(workloads: readonly WorkloadLike[]): string[] {
  const nodes = new Set<string>();
  for (const w of workloads) {
    if (w.metadata?.name === FILE_MANAGER) continue;
    const pin = hostnamePinOf(w.spec?.template?.spec);
    if (pin) nodes.add(pin.node);
  }
  return [...nodes].sort();
}

/**
 * Nodes the tenant's Deployments and StatefulSets are pinned to. Throws when
 * the cluster cannot be read: the caller is deciding what to move, and "no
 * pin" read from a failed list would be a wrong answer, not a cautious one.
 */
export async function workloadPinNodes(
  k8s: Pick<K8sClients, 'apps'>,
  namespace: string,
): Promise<string[]> {
  const [deployments, statefulSets] = await Promise.all([
    k8s.apps.listNamespacedDeployment({ namespace }),
    k8s.apps.listNamespacedStatefulSet({ namespace }),
  ]);
  return pinNodesOf([
    ...((deployments.items ?? []) as WorkloadLike[]),
    ...((statefulSets.items ?? []) as WorkloadLike[]),
  ]);
}

interface SharingDeploymentLike extends WorkloadLike {
  readonly spec?: WorkloadLike['spec'] & {
    readonly template?: {
      readonly spec?: PodTemplateSpecLike & {
        readonly volumes?: ReadonlyArray<{ readonly persistentVolumeClaim?: { readonly claimName?: string } }>;
      };
    };
  };
}

/**
 * Deployments that mount the tenant's claim and carry no hostname pin, less
 * `skip`. Pure. They share the ReadWriteOnce volume with the pinned ones, so
 * left to the scheduler one can start on another node and wait for it forever.
 */
export function unpinnedVolumeSharers(
  deployments: readonly SharingDeploymentLike[],
  claimName: string,
  skip: ReadonlySet<string>,
): string[] {
  return deployments.flatMap((d) => {
    const name = d.metadata?.name;
    const spec = d.spec?.template?.spec;
    if (!name || skip.has(name) || hostnamePinOf(spec)) return [];
    const mounts = (spec?.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === claimName);
    return mounts ? [name] : [];
  });
}

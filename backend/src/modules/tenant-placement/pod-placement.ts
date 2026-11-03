/**
 * Where a pod in a tenant namespace runs, and what it is charged to — ONE
 * place for every creator. `scripts/ci-tenant-pod-placement.sh` fails a file
 * that creates pods in a tenant namespace without going through it (or
 * through the data-node resolver, for a Job that must follow the volume).
 *
 * Why it exists: the pin was copied inline into the catalog and custom
 * deployers, and every platform component added later — the private-worker
 * server, oauth2-proxy, the Ziti and zrok proxies — was written without it.
 * Production: a private worker's pod landed on another server, and the
 * tenant was reported "drifted from its primary node" while its data, its
 * volume and every application sat where they belonged. The same pods carried
 * no priority class, so the tenant-default global default charged them to the
 * tenant's own quota; the private worker's 25m was refused by it.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { tenants } from '../../db/schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { resolveTenantDataNode } from './data-node.js';

export const HOSTNAME_LABEL = 'kubernetes.io/hostname';

/** Tenant workloads — charged to the tenant's quota (its scope). */
export const TENANT_DEFAULT_PRIORITY_CLASS = 'tenant-default';
/**
 * Platform pods that live in a tenant namespace. Never charged to the
 * tenant's quota: the tenant did not choose their size, and one being refused
 * by the tenant's own limit is the failure above.
 */
export const TENANT_OVERHEAD_PRIORITY_CLASS = 'platform-tenant-overhead';

export interface TenantPodPlacement {
  readonly nodeName: string | null;
  readonly storageTier: 'local' | 'ha' | null;
}

interface PodAffinityTermLike {
  labelSelector: { matchLabels: Record<string, string> };
  topologyKey: string;
}

export interface TenantPodScheduling {
  nodeSelector?: Record<string, string>;
  affinity?: {
    nodeAffinity?: {
      preferredDuringSchedulingIgnoredDuringExecution: Array<{
        weight: number;
        preference: { matchExpressions: Array<{ key: string; operator: string; values: string[] }> };
      }>;
    };
    podAffinity?: {
      preferredDuringSchedulingIgnoredDuringExecution: Array<{ weight: number; podAffinityTerm: PodAffinityTermLike }>;
    };
  };
}

/** On every tenant workload pod (both deployers); not on platform pods. */
export const TENANT_WORKLOAD_LABEL = 'platform.io/managed';
const FILE_MANAGER_COMPONENT = { 'platform.io/component': 'file-manager' };

/**
 * An HA tenant's pods prefer the node its other pods run on. They all mount
 * one ReadWriteOnce volume, so a pod placed elsewhere never starts: on the HA
 * tier only a soft node preference held them together, and an Auto HA tenant
 * had none at all — each pod was placed on its own. The file manager counts
 * too, at half the weight: one holding the volume is where it is attached.
 *
 * Preferred, not required, on purpose. The scheduler counts a terminating pod
 * like any other (interpodaffinity/filtering.go), so a REQUIRED term would hold
 * every new pod to the node a dead node's pods are still listed on — exactly
 * the failover HA exists for. No namespace list: a term matches pods of the
 * pod's own namespace.
 */
export const HA_SHARED_VOLUME_AFFINITY: NonNullable<NonNullable<TenantPodScheduling['affinity']>['podAffinity']> = {
  preferredDuringSchedulingIgnoredDuringExecution: [
    { weight: 100, podAffinityTerm: { labelSelector: { matchLabels: { [TENANT_WORKLOAD_LABEL]: 'true' } }, topologyKey: HOSTNAME_LABEL } },
    { weight: 50, podAffinityTerm: { labelSelector: { matchLabels: FILE_MANAGER_COMPONENT }, topologyKey: HOSTNAME_LABEL } },
  ],
};

/** The node constraint alone — what a platform pod in the namespace carries. Pure. */
function hostScheduling(p: TenantPodPlacement): TenantPodScheduling {
  if (!p.nodeName) return {};
  if (p.storageTier === 'ha') {
    return {
      affinity: {
        nodeAffinity: {
          preferredDuringSchedulingIgnoredDuringExecution: [{
            weight: 100,
            preference: {
              matchExpressions: [{ key: HOSTNAME_LABEL, operator: 'In', values: [p.nodeName] }],
            },
          }],
        },
      },
    };
  }
  return { nodeSelector: { [HOSTNAME_LABEL]: p.nodeName } };
}

/**
 * The scheduling constraint a tenant's pods carry. Pure.
 *
 *   HA tier          → a soft preference for the primary node, when there is
 *                      one (the pod may fail over to a node holding a
 *                      surviving replica), and for the node the tenant's other
 *                      pods run on (HA_SHARED_VOLUME_AFFINITY), pinned or Auto
 *   no primary node  → none (an Auto Local tenant's pods are pinned to its
 *                      data node by resolveAutoPlacement first)
 *   local (or unset) → a hard pin: the single replica only exists there
 */
export function tenantPodScheduling(p: TenantPodPlacement): TenantPodScheduling {
  if (p.storageTier !== 'ha') return hostScheduling(p);
  return { affinity: { ...hostScheduling(p).affinity, podAffinity: HA_SHARED_VOLUME_AFFINITY } };
}

/**
 * The pod-spec fields a PLATFORM component in a tenant namespace carries:
 * the tenant's node constraint, and the overhead priority class. Pure. No
 * pull toward the tenant's pods: a platform pod mounts no tenant volume.
 */
export function platformPodPlacement(p: TenantPodPlacement): TenantPodScheduling & { priorityClassName: string } {
  return { ...hostScheduling(p), priorityClassName: TENANT_OVERHEAD_PRIORITY_CLASS };
}

/**
 * Where an Auto tenant's pods run. Auto (no primary node, `tenants.node_name`
 * null) still keeps a Local-tier tenant's pods and its data on one host: the
 * pods are placed on the node holding its volume — where Longhorn has it
 * attached, else a running pod mounts it, else its replica — and the volume
 * carries no node tag (tenant-placement/volume-pin.ts). Left to the scheduler,
 * a pod could start on another node and make Longhorn copy the whole volume
 * across, or do all its disk I/O over the network when the copy is refused.
 *
 * A pinned tenant, an HA tenant (replicas on several nodes by design) and an
 * Auto tenant with no data yet are returned as they are. Never throws: an
 * unreadable cluster leaves the pods unpinned, as before.
 */
export async function resolveAutoPlacement(
  k8s: Pick<K8sClients, 'core' | 'custom'>,
  namespace: string,
  p: TenantPodPlacement,
): Promise<TenantPodPlacement> {
  if (p.nodeName || p.storageTier === 'ha') return p;
  const choice = await resolveTenantDataNode(k8s, {
    namespace,
    pvcName: `${namespace}-storage`,
    pinNode: null,
    // Two replicas while a copy is in flight: no node to choose yet.
    unambiguousOnly: true,
    logger: { warn: (msg) => console.warn(`[pod-placement] ${msg}`) },
  });
  return choice.node ? { ...p, nodeName: choice.node } : p;
}

export function tenantPodPlacementOf(
  tenant: { readonly nodeName?: string | null; readonly storageTier?: string | null } | undefined,
): TenantPodPlacement {
  const tier = tenant?.storageTier;
  return {
    nodeName: tenant?.nodeName ?? null,
    storageTier: tier === 'local' || tier === 'ha' ? tier : null,
  };
}

/**
 * The tenant's placement; unpinned when the tenant row is gone. With `k8s`, an
 * Auto tenant's pods follow its data (`resolveAutoPlacement`).
 */
export async function loadTenantPodPlacement(
  db: Database,
  tenantId: string,
  k8s?: Pick<K8sClients, 'core' | 'custom'>,
): Promise<TenantPodPlacement> {
  const [t] = await db
    .select({ nodeName: tenants.nodeName, storageTier: tenants.storageTier, namespace: tenants.kubernetesNamespace })
    .from(tenants)
    // Primary key: one row at most.
    .where(eq(tenants.id, tenantId));
  const placement = tenantPodPlacementOf(t);
  return k8s && t?.namespace ? resolveAutoPlacement(k8s, t.namespace, placement) : placement;
}

export async function loadTenantPodPlacementByNamespace(
  db: Database,
  namespace: string,
  k8s?: Pick<K8sClients, 'core' | 'custom'>,
): Promise<TenantPodPlacement> {
  const [t] = await db
    .select({ nodeName: tenants.nodeName, storageTier: tenants.storageTier })
    .from(tenants)
    // tenants_namespace_unique: one row at most.
    .where(eq(tenants.kubernetesNamespace, namespace));
  const placement = tenantPodPlacementOf(t);
  return k8s && t ? resolveAutoPlacement(k8s, namespace, placement) : placement;
}

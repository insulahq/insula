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

export interface TenantPodScheduling {
  nodeSelector?: Record<string, string>;
  affinity?: {
    nodeAffinity: {
      preferredDuringSchedulingIgnoredDuringExecution: Array<{
        weight: number;
        preference: { matchExpressions: Array<{ key: string; operator: string; values: string[] }> };
      }>;
    };
  };
}

/**
 * The scheduling constraint a tenant's pods carry. Pure.
 *
 *   no primary node → none
 *   HA tier         → a soft preference: the pod may fail over to a node
 *                     holding a surviving replica when the primary is down
 *   local (or unset) → a hard pin: the single replica only exists there
 */
export function tenantPodScheduling(p: TenantPodPlacement): TenantPodScheduling {
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
 * The pod-spec fields a PLATFORM component in a tenant namespace carries:
 * the tenant's scheduling, and the overhead priority class. Pure.
 */
export function platformPodPlacement(p: TenantPodPlacement): TenantPodScheduling & { priorityClassName: string } {
  return { ...tenantPodScheduling(p), priorityClassName: TENANT_OVERHEAD_PRIORITY_CLASS };
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

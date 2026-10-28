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

export function tenantPodPlacementOf(
  tenant: { readonly nodeName?: string | null; readonly storageTier?: string | null } | undefined,
): TenantPodPlacement {
  const tier = tenant?.storageTier;
  return {
    nodeName: tenant?.nodeName ?? null,
    storageTier: tier === 'local' || tier === 'ha' ? tier : null,
  };
}

/** The tenant's placement; unpinned when the tenant row is gone. */
export async function loadTenantPodPlacement(db: Database, tenantId: string): Promise<TenantPodPlacement> {
  const [t] = await db
    .select({ nodeName: tenants.nodeName, storageTier: tenants.storageTier })
    .from(tenants)
    // Primary key: one row at most.
    .where(eq(tenants.id, tenantId));
  return tenantPodPlacementOf(t);
}

export async function loadTenantPodPlacementByNamespace(db: Database, namespace: string): Promise<TenantPodPlacement> {
  const [t] = await db
    .select({ nodeName: tenants.nodeName, storageTier: tenants.storageTier })
    .from(tenants)
    // tenants_namespace_unique: one row at most.
    .where(eq(tenants.kubernetesNamespace, namespace));
  return tenantPodPlacementOf(t);
}

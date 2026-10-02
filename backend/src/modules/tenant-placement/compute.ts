/**
 * Tenant placement — where a tenant actually runs and keeps its data, compared
 * with its primary node (`tenants.node_name`, labelled "primary data location"
 * in the admin panel). Pure: computed from one fleet-wide cluster read
 * (tenant-health/collect.ts), unit-tested without a cluster.
 *
 * Three views of "where", because each can drift on its own:
 *   workload  nodes running the tenant's long-lived pods (Deployment /
 *             StatefulSet children — not backup or restore Job pods, which are
 *             platform work that comes and goes)
 *   attached  nodes the tenant's Longhorn volumes are attached to — the node
 *             doing the tenant's disk I/O
 *   data      nodes holding a usable replica of the tenant's volumes — where
 *             the bytes are, including for a stopped tenant whose volume is
 *             detached
 *
 * Local tier: everything must be on the primary node; the single replica only
 *   exists there, so a pod anywhere else is either doing all of its disk I/O
 *   across the network or has dragged the volume with it.
 * HA tier: pods may legitimately fail over, so the rule is softer — workloads
 *   and attachment on the primary node, and a replica there. Anything else is
 *   reported, not acted on.
 */
import type { CollectedFacts } from '../tenant-health/collect.js';
import type { PodFact, ReplicaFact, TenantFact, VolumeFact } from '../tenant-health/service.js';

export type PlacementStatus = 'placed' | 'misplaced' | 'unpinned' | 'unknown';

export interface TenantPlacementObservation {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly status: PlacementStatus;
  readonly primaryNode: string | null;
  readonly storageTier: 'local' | 'ha';
  readonly workloadNodes: readonly string[];
  readonly attachedNodes: readonly string[];
  readonly dataNodes: readonly string[];
  /**
   * The one answer to "where is this tenant now", for the tenants table:
   * where it runs (workloads + attachment) when anything runs, else where its
   * data is. Empty for a tenant with neither.
   */
  readonly actualNodes: readonly string[];
  /** Human reasons for `misplaced`, e.g. "running on node-b". Empty otherwise. */
  readonly reasons: readonly string[];
}

/** Controllers whose pods are the tenant's own long-lived workload. */
const WORKLOAD_CONTROLLERS = new Set(['ReplicaSet', 'StatefulSet']);

function uniqSorted(values: Iterable<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const v of values) if (v) out.add(v);
  return [...out].sort();
}

function formatNodes(nodes: readonly string[]): string {
  if (nodes.length <= 1) return nodes[0] ?? '';
  return `${nodes.slice(0, -1).join(', ')} and ${nodes[nodes.length - 1]}`;
}

/** Volumes that are this tenant's live data — not leftovers of a past PVC. */
function tenantVolumes(tenant: TenantFact, volumes: readonly VolumeFact[]): VolumeFact[] {
  return volumes.filter((v) => v.namespace === tenant.namespace && !v.pvcRefLostAt);
}

export function observeTenantPlacement(
  tenant: TenantFact,
  input: {
    readonly pods: readonly PodFact[];
    readonly volumes: readonly VolumeFact[];
    readonly replicas: readonly ReplicaFact[];
  },
): TenantPlacementObservation {
  const vols = tenantVolumes(tenant, input.volumes);
  const volNames = new Set(vols.map((v) => v.volumeName));

  const workloadNodes = uniqSorted(
    input.pods
      .filter((p) => p.namespace === tenant.namespace)
      .filter((p) => p.phase === 'Running' && p.controllerKind !== null && WORKLOAD_CONTROLLERS.has(p.controllerKind))
      .map((p) => p.nodeName),
  );
  const attachedNodes = uniqSorted(vols.filter((v) => v.attached).map((v) => v.attachedNode));
  const dataNodes = uniqSorted(
    input.replicas.filter((r) => volNames.has(r.volumeName) && !r.failed).map((r) => r.nodeId),
  );
  const running = uniqSorted([...workloadNodes, ...attachedNodes]);
  const actualNodes = running.length > 0 ? running : dataNodes;

  const base = {
    tenantId: tenant.id,
    tenantName: tenant.name,
    primaryNode: tenant.pinnedNode,
    storageTier: tenant.storageTier,
    workloadNodes,
    attachedNodes,
    dataNodes,
    actualNodes,
  };

  const primary = tenant.pinnedNode;
  if (!primary) return { ...base, status: 'unpinned', reasons: [] };

  const reasons: string[] = [];
  const offWorkload = workloadNodes.filter((n) => n !== primary);
  const offAttached = attachedNodes.filter((n) => n !== primary && !offWorkload.includes(n));
  if (offWorkload.length > 0) reasons.push(`running on ${formatNodes(offWorkload)}`);
  if (offAttached.length > 0) reasons.push(`volume attached on ${formatNodes(offAttached)}`);

  if (tenant.storageTier === 'ha') {
    if (dataNodes.length > 0 && !dataNodes.includes(primary)) {
      reasons.push(`no data replica on ${primary} (data on ${formatNodes(dataNodes)})`);
    }
  } else {
    const offData = dataNodes.filter((n) => n !== primary);
    if (offData.length > 0) {
      reasons.push(dataNodes.includes(primary)
        // Both: a replica is being built elsewhere — data locality is moving
        // the volume to where a pod runs. Still not where it belongs.
        ? `data being copied to ${formatNodes(offData)}`
        : `data on ${formatNodes(offData)}`);
    }
  }

  return { ...base, status: reasons.length > 0 ? 'misplaced' : 'placed', reasons };
}

/**
 * Every tenant's placement from one cluster read. When the read was incomplete
 * every tenant is `unknown`: a missing replica list must not turn into "data
 * nowhere", and a missing pod list into "nothing misplaced".
 */
export function computePlacements(
  facts: Pick<CollectedFacts, 'tenants' | 'pods' | 'volumes' | 'replicas' | 'readError'>,
): TenantPlacementObservation[] {
  return facts.tenants.map((tenant) => {
    const observed = observeTenantPlacement(tenant, facts);
    return facts.readError ? { ...observed, status: 'unknown', reasons: [] } : observed;
  });
}

export interface StorageFailoverObservation {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly volumeName: string;
  readonly pvcName: string | null;
  /** Longhorn `status.remountRequestedAt`, ISO. */
  readonly remountRequestedAt: string;
}

/**
 * Tenant volumes Longhorn has salvaged at some point. Longhorn keeps the last
 * `remountRequestedAt` on the volume, so the same salvage is seen on every
 * tick — the store dedupes it on (volume, timestamp).
 */
export function observeStorageFailovers(
  facts: Pick<CollectedFacts, 'tenants' | 'volumes'>,
): StorageFailoverObservation[] {
  const out: StorageFailoverObservation[] = [];
  for (const tenant of facts.tenants) {
    for (const v of tenantVolumes(tenant, facts.volumes)) {
      if (!v.remountRequestedAt || Number.isNaN(Date.parse(v.remountRequestedAt))) continue;
      out.push({
        tenantId: tenant.id,
        tenantName: tenant.name,
        volumeName: v.volumeName,
        pvcName: v.pvcName,
        remountRequestedAt: new Date(v.remountRequestedAt).toISOString(),
      });
    }
  }
  return out;
}

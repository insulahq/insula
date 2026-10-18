/**
 * Pick a tenant-capable node for a Local-tier tenant's data: the one with the
 * most free Longhorn-schedulable bytes (alphabetical on a tie). Used at
 * provisioning, and by a drain's "Auto" for a stopped tenant whose data has to
 * move somewhere. Kept apart from storage-placement-service so the drain does
 * not load the provisioner to pick a node.
 */
import { clusterNodes } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export interface NodeCapacityForPick {
  readonly name: string;
  /** bytes free across allowScheduling=true disks on this node */
  readonly freeBytes: number;
  /** can this node host tenant workloads? */
  readonly tenantCapable: boolean;
}

export interface DiskStatus {
  storageMaximum?: number;
  storageScheduled?: number;
}
export interface DiskSpec {
  storageReserved?: number;
  allowScheduling?: boolean;
}
export interface LhNode {
  metadata?: { name?: string };
  spec?: { disks?: Record<string, DiskSpec>; allowScheduling?: boolean };
  status?: { diskStatus?: Record<string, DiskStatus> };
}

/**
 * Auto-pick a worker node for a Local-tier tenant at provisioning.
 * Strategy: among host-tenant-workloads nodes, pick the one with the
 * MOST free Longhorn-schedulable bytes. Tie-break alphabetically for
 * determinism. Returns null if Longhorn is unavailable or no eligible
 * node exists — caller falls back to leaving nodeName null
 * (scheduler picks freely). `exclude` names nodes that must not be picked
 * (a node being drained, cordoned ones).
 */
export async function autoPickWorkerNode(
  db: Database,
  k8s: K8sClients,
  opts: { readonly exclude?: ReadonlySet<string> } = {},
): Promise<string | null> {
  const ranked = await rankNodesByFreeSpace(db, k8s, opts);
  return ranked?.[0]?.name ?? null;
}

/**
 * Every tenant-capable, schedulable node with its free Longhorn bytes, most
 * free first (alphabetical on a tie). Null when Longhorn or the node table
 * cannot be read.
 */
export async function rankNodesByFreeSpace(
  db: Database,
  k8s: K8sClients,
  opts: { readonly exclude?: ReadonlySet<string> } = {},
): Promise<NodeCapacityForPick[] | null> {
  const nodes: NodeCapacityForPick[] = [];
  try {
    const lhResp = await k8s.custom.listNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'nodes',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]);
    const items = ((lhResp as { items?: LhNode[] }).items ?? []);
    const platformNodes = await db.select().from(clusterNodes);
    const tenantCapable = new Map(platformNodes.map((n) => [n.name, n.canHostTenantWorkloads]));

    for (const lh of items) {
      const name = lh.metadata?.name;
      if (!name) continue;
      if (opts.exclude?.has(name)) continue;
      if (lh.spec?.allowScheduling === false) continue;
      if (tenantCapable.size > 0 && tenantCapable.get(name) !== true) continue;
      let free = 0;
      for (const [diskKey, diskSpec] of Object.entries(lh.spec?.disks ?? {})) {
        if (diskSpec.allowScheduling === false) continue;
        const stat = lh.status?.diskStatus?.[diskKey] ?? {};
        free += Math.max(0, (stat.storageMaximum ?? 0) - (stat.storageScheduled ?? 0) - (diskSpec.storageReserved ?? 0));
      }
      nodes.push({ name, freeBytes: free, tenantCapable: true });
    }
  } catch {
    return null;
  }
  return nodes.sort((a, b) => b.freeBytes - a.freeBytes || a.name.localeCompare(b.name));
}

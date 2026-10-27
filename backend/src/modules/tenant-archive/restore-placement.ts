/**
 * Which node an archived tenant comes back on.
 *
 * The archive removed the tenant's volume and kept its data off-site, so
 * nothing ties a restore to the node the tenant was pinned to — but the
 * restore used the pin all the same: the Job that writes the files back is
 * bound to it (`spec.nodeName`), and so are the applications. A pin to a node
 * that is down, gone or no longer takes tenants left the restore waiting until
 * its 6-hour limit, and nothing moved the pin: a drain, a node delete and the
 * HA auto-repin only see a node's Deployments and volumes, which an archived
 * tenant has none of.
 *
 * So the restore takes the node to use — the pin, another node, or Auto — and
 * refuses a node it cannot use, saying why. The page offers the same list with
 * the same reasons (`readRestorePlacement`): one check decides and captions.
 */
import type { Database } from '../../db/index.js';
import { clusterNodes } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export type StorageTier = 'local' | 'ha';

/** What decides whether a restore may use a node. */
export interface RestoreNodeFacts {
  readonly name: string;
  /** In the platform's node table AND in Kubernetes. */
  readonly present: boolean;
  readonly ready: boolean;
  readonly cordoned: boolean;
  /** The server-only taint: no new tenants. */
  readonly serverOnly: boolean;
  /** `nodes/tenant-hosting.ts`: all | pinned | none. */
  readonly hosting: 'all' | 'pinned' | 'none';
}

export interface RestoreNodeChoice {
  readonly name: string;
  /** Why the restore cannot use it; null when it can. */
  readonly problem: string | null;
}

export interface RestorePlacement {
  readonly pinnedNode: string | null;
  readonly storageTier: StorageTier;
  /** Why the pinned node cannot take the restore; null when it can, or there is no pin. */
  readonly pinProblem: string | null;
  /** Every node the cluster knows, with whether the restore may use it. */
  readonly nodes: readonly RestoreNodeChoice[];
}

/** Pure: why `facts` cannot take a restore of a tenant on `tier`, or null. */
export function restoreNodeProblem(facts: RestoreNodeFacts | undefined, tier: StorageTier): string | null {
  if (!facts || !facts.present) return 'is no longer part of the cluster';
  if (!facts.ready) return 'is down (not Ready)';
  if (facts.hosting === 'none') return 'does not host tenants';
  if (facts.cordoned) return 'is cordoned';
  if (facts.serverOnly) return 'takes no tenants (server only)';
  if (tier === 'ha' && facts.hosting === 'pinned') {
    return 'takes pinned tenants only, and this tenant is on the HA storage tier';
  }
  return null;
}

export async function readNodeFacts(db: Database, k8s: K8sClients): Promise<Map<string, RestoreNodeFacts>> {
  const { tenantHostingOf } = await import('../nodes/tenant-hosting.js');
  const { SERVER_ONLY_TAINT_KEY } = await import('../nodes/service.js');
  const rows = await db.select({
    name: clusterNodes.name,
    canHostTenantWorkloads: clusterNodes.canHostTenantWorkloads,
    labels: clusterNodes.labels,
  }).from(clusterNodes);
  const list = await k8s.core.listNode() as {
    items?: Array<{
      metadata?: { name?: string };
      spec?: { unschedulable?: boolean; taints?: Array<{ key?: string; effect?: string }> };
      status?: { conditions?: Array<{ type?: string; status?: string }> };
    }>;
  };
  const live = new Map((list.items ?? []).flatMap((n) => (n.metadata?.name ? [[n.metadata.name, n] as const] : [])));
  const out = new Map<string, RestoreNodeFacts>();
  for (const row of rows) {
    const node = live.get(row.name);
    out.set(row.name, {
      name: row.name,
      present: node !== undefined,
      ready: (node?.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'),
      cordoned: node?.spec?.unschedulable === true,
      serverOnly: (node?.spec?.taints ?? []).some((t) => t.key === SERVER_ONLY_TAINT_KEY && t.effect === 'NoSchedule'),
      hosting: tenantHostingOf(row),
    });
  }
  return out;
}

export async function readRestorePlacement(
  db: Database,
  k8s: K8sClients,
  tenant: { readonly nodeName: string | null; readonly storageTier: string | null },
): Promise<RestorePlacement> {
  const tier: StorageTier = tenant.storageTier === 'ha' ? 'ha' : 'local';
  const facts = await readNodeFacts(db, k8s);
  const nodes = [...facts.values()]
    .map((f) => ({ name: f.name, problem: restoreNodeProblem(f, tier) }))
    // A pin to a node the cluster has forgotten altogether (deleted, its row
    // gone) is listed too: the operator sees which node it was, and why not.
    .concat(tenant.nodeName && !facts.has(tenant.nodeName) ? [{ name: tenant.nodeName, problem: restoreNodeProblem(undefined, tier) }] : [])
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    pinnedNode: tenant.nodeName,
    storageTier: tier,
    pinProblem: tenant.nodeName ? restoreNodeProblem(facts.get(tenant.nodeName), tier) : null,
    nodes,
  };
}

/**
 * The node the restore runs on, to be written as the tenant's pin before it
 * starts. `requested`: undefined = keep the pin; null = Auto; a name = that
 * node. Auto on the Local tier picks the node with the most free space among
 * those that take tenants; on the HA tier it leaves the tenant unpinned.
 */
export async function chooseRestoreNode(
  db: Database,
  k8s: K8sClients,
  tenant: { readonly nodeName: string | null; readonly storageTier: string | null },
  requested: string | null | undefined,
): Promise<string | null> {
  const placement = await readRestorePlacement(db, k8s, tenant);
  if (requested === undefined && placement.pinnedNode) {
    if (placement.pinProblem) {
      throw new ApiError(
        'RESTORE_NODE_UNAVAILABLE',
        `The tenant's node ${placement.pinnedNode} ${placement.pinProblem}`,
        409,
        { node: placement.pinnedNode, problem: placement.pinProblem },
        'Choose another node for the restore, or Auto.',
      );
    }
    return placement.pinnedNode;
  }
  if (typeof requested === 'string') {
    const choice = placement.nodes.find((n) => n.name === requested);
    if (!choice) throw new ApiError('NODE_NOT_FOUND', `Node '${requested}' is not part of the cluster`, 404, { node: requested });
    if (choice.problem) {
      throw new ApiError('RESTORE_NODE_UNAVAILABLE', `Node ${requested} ${choice.problem}`, 409, { node: requested, problem: choice.problem }, 'Choose another node for the restore, or Auto.');
    }
    return requested;
  }
  // Auto.
  if (placement.storageTier === 'ha') return null;
  const { autoPickWorkerNode } = await import('../tenants/auto-pick-node.js');
  const exclude = new Set(placement.nodes.filter((n) => n.problem).map((n) => n.name));
  const picked = await autoPickWorkerNode(db, k8s, { exclude });
  if (!picked) {
    throw new ApiError(
      'NO_NODE_FOR_RESTORE',
      'No node can take the restored tenant: none that hosts all tenants is up, uncordoned and has free storage',
      409,
      undefined,
      'Bring a node that hosts tenants back, or choose a pinned-only node by name.',
    );
  }
  return picked;
}

/**
 * Where an Auto tenant's pods go when a re-pin to Auto takes them off a node —
 * a drain, the recovery wizard, Failback.
 *
 * Auto keeps a Local-tier tenant's pods on one host with its data
 * (tenant-placement/pod-placement.ts). The re-pin used to clear the hostname
 * selector and leave the rest to the scheduler, which places every Deployment
 * on its own; the tenant's Deployments share one ReadWriteOnce volume, so the
 * ones placed away from it wait for it forever. Production: a drain sent a
 * tenant's web pods to the node holding its volume and its database to
 * another, and the CRM on it answered 500 until the tenant was moved by hand.
 *
 * So the pods get ONE node:
 *   1. a node holding a usable copy of the data — nothing is copied;
 *   2. else the node with the most free Longhorn space that can take the
 *      volume (Longhorn's own capacity rule, the check a drain makes for a
 *      stopped tenant); the copy then follows the pods (best-effort locality);
 *   3. else null — the caller clears the pin, as before.
 * Never the node being left, a cordoned one, one that is not Ready, or one
 * that does not take auto-placed tenants (rankNodesByFreeSpace); when the node
 * list cannot be read, no node rather than a guess. A drain moving several
 * tenants passes one `planned` map, so the ones that need a copy are spread by
 * the space this drain already sends to each node instead of all landing on
 * the roomiest. The tenant stays on Auto: no primary node, no volume node tag.
 * Only the Local tier is held to one node; HA (or an unknown tier) gets null.
 */
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { readPvcVolumeName, readVolumeReplicaNodes, readVolumeSizeBytes } from '../tenant-placement/data-node.js';
import { nodesToAvoid, type LiveNodeForPlacement } from './stopped-tenant-placement.js';

export interface AutoTarget {
  readonly node: string | null;
  readonly source: 'replica' | 'free-space' | null;
}

const NONE: AutoTarget = { node: null, source: null };

/** The first eligible node (most free first) that holds a copy, else null. Pure. */
export function replicaTarget(eligible: readonly string[], replicaNodes: readonly string[]): string | null {
  const holding = new Set(replicaNodes);
  return eligible.find((n) => holding.has(n)) ?? null;
}

export async function resolveAutoTarget(
  k8s: K8sClients,
  db: Database,
  args: {
    readonly namespace: string;
    /** Volumes the caller already knows; the tenant's own claim is always added. */
    readonly volumeNames: readonly string[];
    readonly releaseFrom: string;
    readonly storageTier: string | null;
    /** Bytes this drain already sends to each node; updated with this tenant's. */
    readonly planned?: Map<string, number>;
  },
): Promise<AutoTarget> {
  if (args.storageTier !== 'local') return NONE;
  const warn = (msg: string): void => console.warn(`[nodes] auto target for ${args.namespace}: ${msg}`);

  let liveNodes: LiveNodeForPlacement[] = [];
  try {
    liveNodes = ((await k8s.core.listNode()) as { items?: LiveNodeForPlacement[] }).items ?? [];
  } catch (err) {
    // Without it a cordoned or NotReady node could be picked, and pods pinned
    // there never start; the scheduler routes around one.
    warn(`node list failed (${(err as Error).message}); no node picked`);
    return NONE;
  }
  const avoid = nodesToAvoid(args.releaseFrom, liveNodes);
  const { rankNodesByFreeSpace } = await import('../tenants/auto-pick-node.js');
  const ranked = await rankNodesByFreeSpace(db, k8s, { exclude: avoid });
  if (!ranked || ranked.length === 0) {
    warn('no other node takes auto-placed tenants, or Longhorn could not be read');
    return NONE;
  }
  const eligible = ranked.map((n) => n.name);

  const volumes = new Set(args.volumeNames);
  try {
    const own = await readPvcVolumeName(k8s, args.namespace, `${args.namespace}-storage`);
    if (own) volumes.add(own);
  } catch {
    // A tenant with no claim of its own: the volumes the caller named are all there is.
  }
  const replicaNodes: string[] = [];
  for (const v of volumes) {
    try {
      replicaNodes.push(...await readVolumeReplicaNodes(k8s, v));
    } catch (err) {
      warn(`replicas of ${v} could not be read (${(err as Error).message})`);
    }
  }
  const onData = replicaTarget(eligible, replicaNodes);
  if (onData) return { node: onData, source: 'replica' };

  let need = 0;
  for (const v of volumes) {
    try {
      need += await readVolumeSizeBytes(k8s, v);
    } catch {
      // Unknown size: the capacity check below still judges the node.
    }
  }
  const planned = args.planned ?? new Map<string, number>();
  const byRoom = ranked
    .map((n) => ({ name: n.name, room: n.freeBytes - (planned.get(n.name) ?? 0) }))
    .sort((a, b) => b.room - a.room || a.name.localeCompare(b.name));
  const { checkTargetCapacity } = await import('../tenant-placement/target-capacity.js');
  for (const { name: node } of byRoom) {
    const verdict = await checkTargetCapacity(k8s, args.namespace, node, args.storageTier);
    if (verdict.state === 'insufficient') continue;
    planned.set(node, (planned.get(node) ?? 0) + need);
    return { node, source: 'free-space' };
  }
  warn(`no node has room for the data (tried ${eligible.join(', ')})`);
  return NONE;
}

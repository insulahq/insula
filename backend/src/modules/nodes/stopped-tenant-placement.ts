/**
 * Where does a stopped tenant's data go when the node holding it is drained?
 *
 * Longhorn moves a replica only while its volume is attached. A running
 * tenant's data follows its restarted pod; a tenant that runs nothing (stopped,
 * suspended) attaches nothing, so the drain re-pins it AND attaches its volume
 * on the new node (repinTenantPlacement step e — the "Move back" relocation).
 * Seen on production before that: the re-pin changed every label and the only
 * copy stayed on the drained node, the drain never completed, and deleting the
 * node would have deleted the tenant's data.
 *
 * The node is decided here, before the drain changes anything, so a drain that
 * cannot place a tenant's data is refused up front instead of half-done:
 *   - never the drained node, a cordoned one, or one that is not Ready;
 *   - "Auto" takes the tenant-capable node with the most free Longhorn space,
 *     less what this drain already sends there, then asks Longhorn's own
 *     capacity rule (checkTargetCapacity — the same check "Move back" makes);
 *   - an explicit target gets the same capacity check;
 *   - no node fits → 409, nothing touched.
 */
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/** The slice of a drain impact's pinned tenant this needs. */
export interface PinnedTenantForPlacement {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly namespace: string;
  readonly storageTier: 'local' | 'ha';
  readonly currentNodeName: string | null;
  readonly pvcs: ReadonlyArray<{ readonly sizeBytes: number; readonly detached: boolean; readonly isLastReplica: boolean }>;
}

export interface LiveNodeForPlacement {
  readonly metadata?: { readonly name?: string };
  readonly spec?: { readonly unschedulable?: boolean };
  readonly status?: { readonly conditions?: ReadonlyArray<{ readonly type?: string; readonly status?: string }> };
}

/** Bytes of the tenant's detached volumes whose only copy is on the drained node; 0 = nothing stranded. Pure. */
export function strandedBytes(c: PinnedTenantForPlacement): number {
  return c.pvcs.filter((p) => p.detached && p.isLastReplica).reduce((sum, p) => sum + p.sizeBytes, 0);
}

/** The drained node, every cordoned node and every node that is not Ready. Pure. */
export function nodesToAvoid(drainNode: string, liveNodes: readonly LiveNodeForPlacement[]): Set<string> {
  const avoid = new Set<string>([drainNode]);
  for (const n of liveNodes) {
    const name = n.metadata?.name;
    if (!name) continue;
    const ready = (n.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
    if (n.spec?.unschedulable === true || !ready) avoid.add(name);
  }
  return avoid;
}

/**
 * The default for a tenant the request did not mention: keep its pin when that
 * pin is a node that stays; otherwise "Auto" (''). A re-run of the drain then
 * keeps the node an earlier run picked instead of clearing it. Pure.
 */
export function defaultPlacement(c: PinnedTenantForPlacement, avoid: ReadonlySet<string>): string {
  return c.currentNodeName && !avoid.has(c.currentNodeName) ? c.currentNodeName : '';
}

const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/**
 * Resolve every stopped tenant's target. Returns the placement with "Auto"
 * replaced by a node for those tenants, and which node was picked for whom.
 * Throws 409 (nothing changed yet) when a target cannot take the data.
 */
export async function placeStoppedTenants(
  k8s: K8sClients,
  db: Database,
  args: {
    readonly drainNode: string;
    readonly liveNodes: readonly LiveNodeForPlacement[];
    readonly tenants: readonly PinnedTenantForPlacement[];
    readonly placement: Readonly<Record<string, string>>;
  },
): Promise<{ placement: Record<string, string>; picked: Record<string, string> }> {
  const placement: Record<string, string> = { ...args.placement };
  const picked: Record<string, string> = {};
  const stranded = args.tenants
    .map((c) => ({ c, need: strandedBytes(c) }))
    .filter(({ c, need }) => need > 0 && placement[c.tenantId] !== 'stay');
  if (stranded.length === 0) return { placement, picked };

  const avoid = nodesToAvoid(args.drainNode, args.liveNodes);
  const { checkTargetCapacity } = await import('../tenant-placement/target-capacity.js');
  const fits = async (c: PinnedTenantForPlacement, node: string): Promise<{ ok: boolean; detail: string }> => {
    const verdict = await checkTargetCapacity(k8s, c.namespace, node, c.storageTier);
    return verdict.state === 'insufficient' ? { ok: false, detail: verdict.detail } : { ok: true, detail: '' };
  };
  const sending = new Map<string, number>();

  // Explicit targets first: they are the operator's word, and they take room.
  for (const { c, need } of stranded) {
    const target = placement[c.tenantId];
    if (!target) continue;
    if (avoid.has(target)) {
      throw new ApiError(
        'NODE_REPIN_TARGET_UNAVAILABLE',
        `${c.tenantName} is not running, so its data has to be copied to its new node — and '${target}' is ` +
        `being drained, cordoned or not Ready. Pick another node.`,
        409,
        { tenant_id: c.tenantId, target },
      );
    }
    const verdict = await fits(c, target);
    if (!verdict.ok) {
      throw new ApiError('TARGET_NODE_STORAGE_INSUFFICIENT', `${c.tenantName}: ${verdict.detail}`, 409, {
        tenant_id: c.tenantId, node_name: target,
      });
    }
    sending.set(target, (sending.get(target) ?? 0) + need);
  }

  const autos = stranded.filter(({ c }) => placement[c.tenantId] === '').sort((a, b) => b.need - a.need);
  if (autos.length === 0) return { placement, picked };
  const { rankNodesByFreeSpace } = await import('../tenants/auto-pick-node.js');
  const ranked = (await rankNodesByFreeSpace(db, k8s, { exclude: avoid })) ?? [];
  const unplaced: string[] = [];
  for (const { c, need } of autos) {
    const candidates = ranked
      .map((n) => ({ name: n.name, room: n.freeBytes - (sending.get(n.name) ?? 0) }))
      .filter((n) => n.room >= need)
      .sort((a, b) => b.room - a.room || a.name.localeCompare(b.name));
    let chosen: string | null = null;
    for (const n of candidates) {
      if ((await fits(c, n.name)).ok) { chosen = n.name; break; }
    }
    if (!chosen) { unplaced.push(`${c.tenantName} (${gib(need)})`); continue; }
    placement[c.tenantId] = chosen;
    picked[c.tenantId] = chosen;
    sending.set(chosen, (sending.get(chosen) ?? 0) + need);
  }
  if (unplaced.length > 0) {
    throw new ApiError(
      'NODE_DRAIN_NO_ROOM_FOR_STOPPED_TENANT',
      `No node can take the data of ${unplaced.join(', ')}: ${unplaced.length === 1 ? 'that tenant is' : 'those tenants are'} ` +
      `not running, so the drain has to copy the data to a new node. Pick a node for ${unplaced.length === 1 ? 'it' : 'them'}, ` +
      `or free space, then drain again.${ranked.length === 0 ? ' (No other tenant-capable node is schedulable, or storage could not be read.)' : ''}`,
      409,
      { tenants: unplaced },
    );
  }
  return { placement, picked };
}

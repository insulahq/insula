/**
 * Node membership notifications — "joined the cluster" / "removed from the
 * cluster" — detected from the PERSISTED inventory (`cluster_nodes`), never
 * from in-memory state, so a platform-api restart re-announces nothing.
 *
 * Rules (each one is a test in lifecycle.test.ts):
 *
 *   BASELINE  An empty inventory is a fresh install or a fresh database. Every
 *             node in the first sync is recorded and NOTHING is announced.
 *   JOINED    A live node with no inventory row, or whose row is marked
 *             removed (a re-join). Claimed with INSERT … ON CONFLICT DO NOTHING
 *             RETURNING / UPDATE … WHERE removed_at IS NOT NULL RETURNING, so
 *             exactly one platform-api replica announces it.
 *   REMOVED   A row whose node is missing from a SUCCESSFUL, NON-EMPTY Node
 *             list. A failed list throws before we get here; an empty list is
 *             treated as an API anomaly, not as every node leaving at once.
 *             Claimed with UPDATE … SET removed_at WHERE removed_at IS NULL.
 *   STALE     A missing row last seen longer ago than REMOVAL_NEWS_WINDOW_MS is
 *             an orphan that predates this feature (or a very long platform
 *             outage): it is marked removed but not announced, so the first
 *             deploy does not mail a "removed" for every long-gone node.
 *
 * The inventory is read BEFORE the Node list. That ordering is what keeps two
 * replicas from turning a removal into a phantom re-join: a replica can only see
 * `removed_at` set if its own (later) list call genuinely contains the node.
 *
 * Notifications are dispatched after the claims are persisted, so a dispatch
 * failure can never cause a transition to be re-detected and re-sent.
 */
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { formatUtcMinute } from '../../shared/format-utc.js';
import type { Database } from '../../db/index.js';
import { clusterNodes } from '../../db/schema.js';
import type { ObservedNode } from './service.js';

/** A row last seen longer ago than this is not news when found missing. */
export const REMOVAL_NEWS_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface InventoryEntry {
  readonly name: string;
  readonly role: string;
  readonly publicIp: string | null;
  readonly publicIpv6: string | null;
  readonly lastSeenAt: Date;
  readonly removedAt: Date | null;
}

export type ArrivalKind = 'new' | 'rejoin';

export interface LifecyclePlan {
  /** True when the inventory was empty: record everything, announce nothing. */
  readonly baseline: boolean;
  /** Live nodes that look like arrivals — still to be CLAIMED before announcing. */
  readonly arrivals: ReadonlyMap<string, ArrivalKind>;
  /** Missing rows to claim AND announce. */
  readonly departures: readonly InventoryEntry[];
  /** Missing rows to claim silently (stale orphans). */
  readonly staleDepartures: readonly InventoryEntry[];
}

/** Pure: what the inventory and one successful Node list say happened. */
export function planNodeLifecycle(
  inventory: readonly InventoryEntry[],
  liveNames: readonly string[],
  now: Date,
): LifecyclePlan {
  if (inventory.length === 0) {
    return { baseline: true, arrivals: new Map(), departures: [], staleDepartures: [] };
  }
  const byName = new Map(inventory.map((row) => [row.name, row]));
  const live = new Set(liveNames);

  const arrivals = new Map<string, ArrivalKind>();
  for (const name of live) {
    const row = byName.get(name);
    if (!row) arrivals.set(name, 'new');
    else if (row.removedAt !== null) arrivals.set(name, 'rejoin');
  }

  // An empty successful list means the API answered with nothing — not that
  // every node left at once. Never announce a fleet-wide removal from it.
  const missing = live.size === 0
    ? []
    : inventory.filter((row) => row.removedAt === null && !live.has(row.name));
  const isStale = (row: InventoryEntry) => now.getTime() - row.lastSeenAt.getTime() > REMOVAL_NEWS_WINDOW_MS;

  return {
    baseline: false,
    arrivals,
    departures: missing.filter((row) => !isStale(row)),
    staleDepartures: missing.filter(isStale),
  };
}

/** The persistence the lifecycle needs. Every write is a CLAIM: true = this caller won. */
export interface NodeInventoryRepo {
  readInventory(): Promise<InventoryEntry[]>;
  /** Insert the row if no row by that name exists. */
  claimNew(observed: ObservedNode): Promise<boolean>;
  /** Clear `removed_at` on a row that has it set. */
  claimRejoin(name: string): Promise<boolean>;
  /** Set `removed_at` on a row that does not have it set. */
  claimRemoval(name: string, at: Date): Promise<boolean>;
}

export function drizzleInventoryRepo(db: Database): NodeInventoryRepo {
  return {
    async readInventory() {
      const rows = await db.select({
        name: clusterNodes.name,
        role: clusterNodes.role,
        publicIp: clusterNodes.publicIp,
        publicIpv6: clusterNodes.publicIpv6,
        lastSeenAt: clusterNodes.lastSeenAt,
        removedAt: clusterNodes.removedAt,
      }).from(clusterNodes);
      return rows.map((r) => ({ ...r, removedAt: r.removedAt ?? null }));
    },
    async claimNew(observed) {
      // Only identity columns: the regular upsert that follows writes the rest
      // in the same tick. role + canHostTenantWorkloads are included so the row
      // is never briefly a server that claims to host tenants.
      const rows = await db.insert(clusterNodes).values({
        name: observed.name,
        role: observed.role,
        canHostTenantWorkloads: observed.canHostTenantWorkloads,
        ingressMode: observed.ingressMode,
        publicIp: observed.publicIp,
        publicIpv6: observed.publicIpv6,
        kubeletVersion: observed.kubeletVersion,
        k3sVersion: observed.k3sVersion,
      }).onConflictDoNothing({ target: clusterNodes.name }).returning({ name: clusterNodes.name });
      return rows.length > 0;
    },
    async claimRejoin(name) {
      const rows = await db.update(clusterNodes)
        .set({ removedAt: null })
        .where(and(eq(clusterNodes.name, name), isNotNull(clusterNodes.removedAt)))
        .returning({ name: clusterNodes.name });
      return rows.length > 0;
    },
    async claimRemoval(name, at) {
      const rows = await db.update(clusterNodes)
        .set({ removedAt: at })
        .where(and(eq(clusterNodes.name, name), isNull(clusterNodes.removedAt)))
        .returning({ name: clusterNodes.name });
      return rows.length > 0;
    },
  };
}

/** Claim one arrival right before its regular upsert. Never throws. */
export async function claimArrival(
  repo: NodeInventoryRepo,
  kind: ArrivalKind,
  observed: ObservedNode,
): Promise<boolean> {
  try {
    return kind === 'new' ? await repo.claimNew(observed) : await repo.claimRejoin(observed.name);
  } catch (err) {
    console.warn(`[node-sync] could not record the arrival of ${observed.name}:`, (err as Error).message);
    return false;
  }
}

/** Claim every departure; returns the ones THIS caller should announce. Never throws. */
export async function claimDepartures(
  repo: NodeInventoryRepo,
  plan: LifecyclePlan,
  now: Date,
): Promise<InventoryEntry[]> {
  const announce: InventoryEntry[] = [];
  for (const row of [...plan.departures, ...plan.staleDepartures]) {
    try {
      const won = await repo.claimRemoval(row.name, now);
      if (!won) continue;
      if (plan.departures.includes(row)) {
        announce.push(row);
      } else {
        console.log(
          `[node-sync] ${row.name} is no longer registered with Kubernetes (last seen `
          + `${formatUtcMinute(row.lastSeenAt)}) — recorded as removed without a notification: `
          + 'it was gone long before this was noticed.',
        );
      }
    } catch (err) {
      console.warn(`[node-sync] could not record the removal of ${row.name}:`, (err as Error).message);
    }
  }
  return announce;
}

/** Re-exported: callers imported it from here before it moved to `shared/`. */
export { formatUtcMinute };

/** Public addresses as recorded on an inventory row. */
export function inventoryAddresses(row: Pick<InventoryEntry, 'publicIp' | 'publicIpv6'>): string {
  const list = [row.publicIp, row.publicIpv6].filter((a): a is string => Boolean(a));
  return list.length > 0 ? list.join(', ') : 'no address recorded';
}

/** Every Node address, labelled — "10.0.0.5 (internal), 192.0.2.56 (external)". */
export function nodeAddressesText(
  addresses: ReadonlyArray<{ readonly type?: string; readonly address?: string }>,
): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const a of addresses) {
    if (!a.address || seen.has(a.address)) continue;
    if (a.type !== 'InternalIP' && a.type !== 'ExternalIP') continue;
    seen.add(a.address);
    parts.push(`${a.address} (${a.type === 'InternalIP' ? 'internal' : 'external'})`);
  }
  return parts.length > 0 ? parts.join(', ') : 'none reported yet';
}

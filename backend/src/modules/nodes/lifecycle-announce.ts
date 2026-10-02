/**
 * Wording + dispatch for the node membership notifications. Detection and the
 * exactly-once claims live in lifecycle.ts; this file only turns a claimed
 * transition into an operator-facing message.
 */
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  notifyAdminNodeJoined,
  notifyAdminNodeRemoved,
  type AdminNodeJoinedPayload,
  type AdminNodeRemovedPayload,
} from '../notifications/events.js';
import {
  formatGraceUntil,
  joinGraceFor,
  listPendingPeerWindows,
  nodeJoinGraceMs,
  type JoinGraceNode,
  type JoinGraceVerdict,
} from '../node-health/join-grace.js';
import { formatUtcMinute, inventoryAddresses, type InventoryEntry } from './lifecycle.js';

/** What a claimed arrival is announced with. */
export interface ArrivalFacts {
  readonly name: string;
  readonly role: string;
  /** Pre-rendered, see nodeAddressesText(). */
  readonly addressesText: string;
  readonly kubeletVersion: string | null;
  /** Node creationTimestamp — the registration instant. */
  readonly createdAt: Date | null;
  /** Raw addresses, for the pending-peer half of the grace rule. */
  readonly addresses: readonly string[];
}

export type RemovalSource = 'kubernetes' | 'admin-panel';

export function graceNoteFor(verdict: JoinGraceVerdict | null): string {
  if (!verdict) return 'Health alerts for it are active.';
  return `Health alerts for it are held until ${formatGraceUntil(verdict.until)} while it finishes `
    + 'bootstrapping; if it is still unhealthy then, you will be alerted.';
}

export function buildJoinedPayload(
  facts: ArrivalFacts,
  verdict: JoinGraceVerdict | null,
  now: Date,
): AdminNodeJoinedPayload {
  return {
    nodeName: facts.name,
    nodeRole: facts.role,
    addresses: facts.addressesText,
    k8sVersion: facts.kubeletVersion ?? 'not reported yet',
    graceNote: graceNoteFor(verdict),
    occurredAt: (facts.createdAt ?? now).toISOString(),
  };
}

export function buildRemovedPayload(row: InventoryEntry, source: RemovalSource): AdminNodeRemovedPayload {
  const removalDetail = source === 'admin-panel'
    ? 'It was deleted from Cluster → Nodes in the admin panel.'
    : `It is no longer registered with the Kubernetes API (last seen ${formatUtcMinute(row.lastSeenAt)}). `
      + 'Its inventory row is kept in Cluster → Nodes for review; remove it there once the host is '
      + 'decommissioned, or rejoin the host if the removal was not intended.';
  return {
    nodeName: row.name,
    nodeRole: row.role,
    addresses: inventoryAddresses(row),
    removalDetail,
  };
}

export function joinedDedupeKey(facts: Pick<ArrivalFacts, 'name' | 'createdAt'>): string {
  return `node-joined:${facts.name}:${facts.createdAt ? facts.createdAt.toISOString() : 'unknown'}`;
}

export function removedDedupeKey(row: Pick<InventoryEntry, 'name' | 'lastSeenAt'>): string {
  return `node-removed:${row.name}:${row.lastSeenAt.toISOString()}`;
}

/**
 * Announce claimed arrivals. The pending-peer list (one API call) is only
 * fetched when there is something to announce, which is rare.
 */
export async function announceArrivals(
  db: Database,
  k8s: Pick<K8sClients, 'custom'>,
  arrivals: readonly ArrivalFacts[],
  now: Date,
): Promise<void> {
  if (arrivals.length === 0) return;
  const graceMs = nodeJoinGraceMs();
  const peers = graceMs > 0 ? await listPendingPeerWindows(k8s) : [];
  for (const facts of arrivals) {
    const graceNode: JoinGraceNode = { name: facts.name, createdAt: facts.createdAt, addresses: facts.addresses };
    const verdict = joinGraceFor(graceNode, peers, now, graceMs);
    console.log(
      `[node-sync] ${facts.name} joined the cluster as a ${facts.role}`
      + (verdict ? ` — health alerts held until ${formatGraceUntil(verdict.until)}` : ''),
    );
    await notifyAdminNodeJoined(db, buildJoinedPayload(facts, verdict, now), joinedDedupeKey(facts));
  }
}

export async function announceDepartures(
  db: Database,
  rows: readonly InventoryEntry[],
  source: RemovalSource,
): Promise<void> {
  for (const row of rows) {
    console.log(`[node-sync] ${row.name} was removed from the cluster (${source})`);
    await notifyAdminNodeRemoved(db, buildRemovedPayload(row, source), removedDedupeKey(row));
  }
}

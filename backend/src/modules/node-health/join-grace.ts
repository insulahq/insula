/**
 * Join grace window — hold node health/readiness ALERTS while a node is still
 * bootstrapping.
 *
 * A server or worker that is joining spends its first minutes NotReady, with
 * Calico, the Longhorn CSI plugin and the kubelet's own conditions coming up one
 * at a time. Every detector treated that as an outage: the fast down-watch
 * announced the brand-new node as "down" on its first sighting, the 5-minute
 * reconciler flagged it CRITICAL, and the subsystem watcher reported Calico and
 * Longhorn CSI "missing" — all while the operator was watching the bootstrap
 * scroll past in a terminal.
 *
 * WHAT IS SUPPRESSED: notifications only. The node row, `node_health_state`,
 * memory-event rows and the panel keep showing the real state the whole time.
 *
 * WHEN A NODE IS "JOINING" (either is enough):
 *
 *   1. its Kubernetes Node object is younger than the grace window. The
 *      `metadata.creationTimestamp` is stamped by the API server, so a
 *      platform-api restart or a database restore cannot reset it — unlike
 *      `cluster_nodes.joined_at`, which is a first-seen time in OUR database. A
 *      node that is deleted and re-registered gets a new object and therefore a
 *      fresh window, which is correct: it is bootstrapping again.
 *   2. a ClusterPendingPeer for one of its addresses still exists AND was
 *      created less than one grace window ago. The CR is how an operator
 *      announces "a node is about to join from this IP"; the cap keeps a
 *      forgotten CR (TTL up to 24 h) from silencing a node for a day.
 *
 * NO LOST ALERT: each detector keeps the suppressed state OUT of whatever it
 * compares against next time (the reconciler clears `last_notified_at`, the
 * in-memory watchers simply do not record the node), so a node that is still
 * unhealthy when the window closes reads as a NEW problem and is announced on
 * the first tick after it.
 */
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { CRD_GROUP, CRD_VERSION, CPP_PLURAL } from '../cluster-network/k8s-client.js';

export const DEFAULT_NODE_JOIN_GRACE_MINUTES = 30;
/** A day. Anything longer is not a bootstrap, it is a silenced node. */
export const MAX_NODE_JOIN_GRACE_MINUTES = 24 * 60;
export const NODE_JOIN_GRACE_ENV = 'NODE_JOIN_ALERT_GRACE_MINUTES';

export type JoinGraceReason = 'new-node' | 'pending-peer';

export interface JoinGraceVerdict {
  /** Alerts for this node resume at this instant. */
  readonly until: Date;
  readonly reason: JoinGraceReason;
}

/** The node facts the window is computed from. */
export interface JoinGraceNode {
  readonly name: string;
  /** Node `metadata.creationTimestamp`. null when the API omitted it. */
  readonly createdAt: Date | null;
  /** Every address the Node publishes (InternalIP + ExternalIP, both families). */
  readonly addresses: readonly string[];
}

export interface PendingPeerWindow {
  readonly ip: string;
  readonly createdAt: Date | null;
}

/** Raw Node subset — the typed client hands back Dates, raw JSON hands back strings. */
export interface RawGraceNode {
  readonly metadata?: { readonly name?: string; readonly creationTimestamp?: Date | string };
  readonly status?: { readonly addresses?: ReadonlyArray<{ readonly type?: string; readonly address?: string }> };
}

let warnedBadEnv = false;

/**
 * The grace window in ms, from `NODE_JOIN_ALERT_GRACE_MINUTES`.
 *
 * Unset (or blank) means the default. `0` is a real value and DISABLES the
 * window — it must not be confused with "unset". A garbage value falls back to
 * the default with one warning rather than silently disabling alerting.
 */
export function nodeJoinGraceMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env[NODE_JOIN_GRACE_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_NODE_JOIN_GRACE_MINUTES * 60_000;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) {
    if (!warnedBadEnv) {
      warnedBadEnv = true;
      console.warn(
        `[node-join-grace] ignoring ${NODE_JOIN_GRACE_ENV}=${JSON.stringify(raw)} — `
        + `using the default of ${DEFAULT_NODE_JOIN_GRACE_MINUTES} minutes`,
      );
    }
    return DEFAULT_NODE_JOIN_GRACE_MINUTES * 60_000;
  }
  return Math.min(minutes, MAX_NODE_JOIN_GRACE_MINUTES) * 60_000;
}

/** Kubernetes timestamps arrive as Date (typed client) or string (custom objects). */
export function parseK8sTime(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toGraceNode(raw: RawGraceNode): JoinGraceNode | null {
  const name = raw.metadata?.name;
  if (!name) return null;
  const addresses = (raw.status?.addresses ?? [])
    .map((a) => a.address ?? '')
    .filter((a) => a.length > 0);
  return { name, createdAt: parseK8sTime(raw.metadata?.creationTimestamp), addresses };
}

function stripPrefixLength(ip: string): string {
  const slash = ip.indexOf('/');
  return (slash === -1 ? ip : ip.slice(0, slash)).trim();
}

/** Address equality that survives IPv6 spelling differences ("::1" vs "0:0::1"). */
export function sameAddress(a: string, b: string): boolean {
  const x = stripPrefixLength(a);
  const y = stripPrefixLength(b);
  if (isIPv4(x) && isIPv4(y)) return x === y;
  if (isIPv6(x) && isIPv6(y)) {
    const list = new BlockList();
    list.addAddress(x, 'ipv6');
    return list.check(y, 'ipv6');
  }
  return false;
}

/**
 * Whether `node` is inside its join grace window at `now`, and until when.
 * Pure. Returns the LATEST of the applicable windows, capped at `now + graceMs`
 * so an API-server clock running ahead can never stretch it.
 */
export function joinGraceFor(
  node: JoinGraceNode,
  pendingPeers: readonly PendingPeerWindow[],
  now: Date,
  graceMs: number,
): JoinGraceVerdict | null {
  if (graceMs <= 0) return null;
  const nowMs = now.getTime();
  const cap = nowMs + graceMs;
  const starts: ReadonlyArray<{ readonly at: Date | null; readonly reason: JoinGraceReason }> = [
    { at: node.createdAt, reason: 'new-node' },
    ...pendingPeers
      .filter((peer) => node.addresses.some((addr) => sameAddress(addr, peer.ip)))
      .map((peer) => ({ at: peer.createdAt, reason: 'pending-peer' as const })),
  ];
  return starts.reduce<JoinGraceVerdict | null>((best, start) => {
    if (!start.at) return best;
    const untilMs = Math.min(start.at.getTime() + graceMs, cap);
    if (untilMs <= nowMs) return best;
    if (best && best.until.getTime() >= untilMs) return best;
    return { until: new Date(untilMs), reason: start.reason };
  }, null);
}

/** `joinGraceFor` over a whole Node list, keyed by node name. Joining nodes only. */
export function joinGraceIndex(
  rawNodes: readonly RawGraceNode[],
  pendingPeers: readonly PendingPeerWindow[],
  now: Date,
  graceMs: number,
): ReadonlyMap<string, JoinGraceVerdict> {
  const out = new Map<string, JoinGraceVerdict>();
  for (const raw of rawNodes) {
    const node = toGraceNode(raw);
    if (!node) continue;
    const verdict = joinGraceFor(node, pendingPeers, now, graceMs);
    if (verdict) out.set(node.name, verdict);
  }
  return out;
}

interface RawPendingPeer {
  readonly metadata?: { readonly creationTimestamp?: string };
  readonly spec?: { readonly ip?: string };
  readonly status?: { readonly normalizedIp?: string };
}

/**
 * Every ClusterPendingPeer as an (ip, createdAt) window. Never throws: a failed
 * list just means the pending-peer half of the rule cannot apply this tick,
 * which errs on the side of ALERTING — the safe direction for a monitor.
 */
export async function listPendingPeerWindows(
  k8s: Pick<K8sClients, 'custom'>,
): Promise<PendingPeerWindow[]> {
  try {
    const res = (await k8s.custom.listClusterCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      plural: CPP_PLURAL,
    } as unknown as Parameters<typeof k8s.custom.listClusterCustomObject>[0])) as {
      items?: readonly RawPendingPeer[];
    };
    return (res.items ?? [])
      .map((cr) => ({
        ip: stripPrefixLength(cr.status?.normalizedIp ?? cr.spec?.ip ?? ''),
        createdAt: parseK8sTime(cr.metadata?.creationTimestamp),
      }))
      .filter((p) => p.ip.length > 0);
  } catch (err) {
    const status = (err as { code?: number }).code ?? (err as { statusCode?: number }).statusCode;
    if (status !== 404) {
      console.warn('[node-join-grace] ClusterPendingPeer list failed:', (err as Error).message);
    }
    return [];
  }
}

/**
 * The full verdict map for one tick: creation-time windows always, plus the
 * pending-peer windows (one cluster-scoped list call).
 */
export async function loadJoinGrace(
  k8s: Pick<K8sClients, 'custom'>,
  rawNodes: readonly RawGraceNode[],
  now: Date,
  graceMs: number = nodeJoinGraceMs(),
): Promise<ReadonlyMap<string, JoinGraceVerdict>> {
  if (graceMs <= 0 || rawNodes.length === 0) return new Map();
  const peers = await listPendingPeerWindows(k8s);
  return joinGraceIndex(rawNodes, peers, now, graceMs);
}

/**
 * A per-tick, load-on-first-use verdict map for callers that usually do not
 * need one — the SLO evaluator only asks while a node-scoped rule is
 * violated, so a healthy cluster costs no API calls. The Node list and the
 * ClusterPendingPeer list are fetched at most once per loader.
 *
 * Never rejects: a failed Node list yields an empty map, i.e. no node is
 * treated as joining and its alerts go out — the safe direction for a monitor.
 */
export function lazyJoinGrace(
  k8s: Pick<K8sClients, 'core' | 'custom'>,
  now: Date,
  graceMs: number = nodeJoinGraceMs(),
): () => Promise<ReadonlyMap<string, JoinGraceVerdict>> {
  let loaded: Promise<ReadonlyMap<string, JoinGraceVerdict>> | null = null;
  return () => {
    loaded ??= (async () => {
      if (graceMs <= 0) return new Map<string, JoinGraceVerdict>();
      try {
        const list = (await k8s.core.listNode({})) as { items?: readonly RawGraceNode[] };
        return await loadJoinGrace(k8s, list.items ?? [], now, graceMs);
      } catch (err) {
        console.warn('[node-join-grace] Node list failed — alerting as usual:', (err as Error).message);
        return new Map<string, JoinGraceVerdict>();
      }
    })();
    return loaded;
  };
}

/** "14:32 UTC" — what the operator compares against a wall clock. */
export function formatGraceUntil(until: Date): string {
  return `${until.toISOString().slice(11, 16)} UTC`;
}

/** One log line, shared by every detector so the wording is grep-able. */
export function describeSuppression(nodeName: string, verdict: JoinGraceVerdict, what: string): string {
  const why = verdict.reason === 'new-node' ? 'joined recently' : 'ClusterPendingPeer still open';
  return `${nodeName} is joining (${why}) — ${what} suppressed until ${formatGraceUntil(verdict.until)}`;
}

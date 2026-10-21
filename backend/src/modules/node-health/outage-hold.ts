/**
 * Outage hold — while a node is down, and for a short settle window after it
 * is Ready again, alerts ABOUT that node are recorded but not sent.
 *
 * When a server goes down the operator hears it from the node's own lifecycle
 * notices: down (or shutting down), then startup complete. Everything that
 * runs on the node fails with it — Calico and the Longhorn CSI read degraded,
 * the kubelet's scrape targets read down, node-scoped SLO rules trip — and each
 * of those used to arrive as its own notification for the same root cause
 * (operator report after a planned shutdown of one server). They are not noise
 * in general, only while the node is already reported down and in the minutes
 * after it is back, while its pods start again.
 *
 * Same contract as the join grace window (join-grace.ts), and merged into the
 * same per-node map:
 *   - notifications only: the state is recorded and the panel shows it;
 *   - an alert still true when the hold ends is announced as new on the first
 *     tick after it, and one that cleared inside it sends no "recovered";
 *   - news already sent about the node is not withdrawn — each detector keeps
 *     its "already announced" rule, so a problem reported BEFORE the outage
 *     still gets its "recovered".
 *
 * NOT for the detectors that announce the outage itself (the fast down-watch,
 * the reconciler's severity and boot notices): they would hold back the very
 * notice this hold relies on.
 */
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  loadJoinGrace,
  nodeJoinGraceMs,
  parseK8sTime,
  type JoinGraceVerdict,
  type RawGraceNode,
} from './join-grace.js';

/**
 * How long a node's alerts stay held after it is Ready again. Long enough for
 * its Calico, CSI, Longhorn and Traefik pods to start and be scraped once; a
 * problem that outlives it is a real one and is announced.
 */
export const NODE_RECOVERY_SETTLE_MS = 10 * 60_000;

/** A Node as the hold reads it: the join fields plus the Ready condition. */
export interface RawOutageNode extends RawGraceNode {
  readonly status?: RawGraceNode['status'] & {
    readonly conditions?: ReadonlyArray<{
      readonly type?: string;
      readonly status?: string;
      readonly lastTransitionTime?: Date | string;
    }>;
  };
}

/**
 * The hold for one node at `now`, or null. Pure.
 *
 * Not Ready (False or Unknown, or no Ready condition at all) is "down": held
 * for as long as it lasts, and `until` is the earliest it could end. Ready is
 * held until `holdAfterReadyMs` after the Ready condition last changed — the kubelet
 * stamps that, so a platform-api restart cannot stretch or reset it.
 */
export function outageHoldFor(node: RawOutageNode, now: Date, holdAfterReadyMs: number = NODE_RECOVERY_SETTLE_MS): JoinGraceVerdict | null {
  const nowMs = now.getTime();
  const ready = (node.status?.conditions ?? []).find((c) => c.type === 'Ready');
  if (ready?.status !== 'True') return { until: new Date(nowMs + holdAfterReadyMs), reason: 'node-down' };
  const since = parseK8sTime(ready.lastTransitionTime);
  if (!since) return null;
  // Capped at now + settle, so an API-server clock running ahead cannot stretch it.
  const untilMs = Math.min(since.getTime() + holdAfterReadyMs, nowMs + holdAfterReadyMs);
  return untilMs > nowMs ? { until: new Date(untilMs), reason: 'back-recently' } : null;
}

/** Whether a verdict in the merged map is this hold rather than the join window. */
export function isOutageHold(verdict: JoinGraceVerdict): boolean {
  return verdict.reason === 'node-down' || verdict.reason === 'back-recently';
}

/** `outageHoldFor` over a Node list, keyed by node name. Held nodes only. */
export function outageHoldIndex(
  rawNodes: readonly RawOutageNode[],
  now: Date,
  holdAfterReadyMs: number = NODE_RECOVERY_SETTLE_MS,
): ReadonlyMap<string, JoinGraceVerdict> {
  const out = new Map<string, JoinGraceVerdict>();
  for (const raw of rawNodes) {
    const name = raw.metadata?.name;
    if (!name) continue;
    const verdict = outageHoldFor(raw, now, holdAfterReadyMs);
    if (verdict) out.set(name, verdict);
  }
  return out;
}

/**
 * Both maps in one. A node in both keeps the verdict that ends LATER; on a
 * tie the join verdict wins, so the log names the bootstrap rather than an
 * outage of a node that never ran.
 */
export function mergeNodeHolds(
  joining: ReadonlyMap<string, JoinGraceVerdict>,
  outage: ReadonlyMap<string, JoinGraceVerdict>,
): ReadonlyMap<string, JoinGraceVerdict> {
  const out = new Map(joining);
  for (const [name, verdict] of outage) {
    const held = out.get(name);
    if (!held || verdict.until.getTime() > held.until.getTime()) out.set(name, verdict);
  }
  return out;
}

/** Every hold for one tick: join grace (with its pending-peer list) plus outages. */
export async function loadNodeAlertHolds(
  k8s: Pick<K8sClients, 'custom'>,
  rawNodes: readonly RawOutageNode[],
  now: Date,
  joinGraceMs: number = nodeJoinGraceMs(),
): Promise<ReadonlyMap<string, JoinGraceVerdict>> {
  return mergeNodeHolds(await loadJoinGrace(k8s, rawNodes, now, joinGraceMs), outageHoldIndex(rawNodes, now));
}

/**
 * A per-tick, load-on-first-use hold map for callers that usually do not need
 * one — the SLO evaluator only asks while a node-scoped rule is violated, so a
 * healthy cluster costs no API calls. The Node list and the
 * ClusterPendingPeer list are fetched at most once per loader.
 *
 * Never rejects: a failed Node list yields an empty map, i.e. nothing is held
 * and alerts go out — the safe direction for a monitor.
 */
export function lazyNodeAlertHolds(
  k8s: Pick<K8sClients, 'core' | 'custom'>,
  now: Date,
  joinGraceMs: number = nodeJoinGraceMs(),
): () => Promise<ReadonlyMap<string, JoinGraceVerdict>> {
  let loaded: Promise<ReadonlyMap<string, JoinGraceVerdict>> | null = null;
  return () => {
    loaded ??= (async () => {
      try {
        const list = (await k8s.core.listNode({})) as { items?: readonly RawOutageNode[] };
        return await loadNodeAlertHolds(k8s, list.items ?? [], now, joinGraceMs);
      } catch (err) {
        console.warn('[node-alert-hold] Node list failed — alerting as usual:', (err as Error).message);
        return new Map<string, JoinGraceVerdict>();
      }
    })();
    return loaded;
  };
}

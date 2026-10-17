/**
 * Server nodes, counted two ways.
 *
 * `present` is what HA sizes to: every server the cluster has, Ready or not.
 * `ready` is what the operator is shown and what the HA recommendation waits
 * for.
 *
 * Sizing used to follow `ready`. A server that was merely down — rebooting,
 * in maintenance, mid k3s upgrade — then shrank HA on the next 5-minute
 * advisor tick: Postgres 3 → 2 instances — and CNPG never removes a not-Ready
 * instance, so it deleted a HEALTHY one with its volume (findDeletableInstance,
 * CNPG v1.30) — platform volumes 3 → 2 Longhorn replicas, panels and API
 * 3 → 2. When the server came back everything grew again, which meant cloning
 * a new Postgres instance and rebuilding every replica. A server now keeps its share until it
 * is removed from the cluster (its Node object deleted — the node card's
 * Delete). A server that is gone for good leaves its replicas Pending until
 * then; the offline-node banner says so.
 *
 * A server that is still JOINING is not counted until it is Ready: a Node
 * object younger than the join window (node-health/join-grace.ts) that has
 * not come up yet is a bootstrap in progress, and growing HA onto it would
 * leave the new replicas Pending — for good, if the join failed. Past the
 * window a NotReady server counts like any other server that is down.
 */
import { DEFAULT_NODE_JOIN_GRACE_MINUTES } from '../node-health/join-grace.js';

const JOIN_WINDOW_MS = DEFAULT_NODE_JOIN_GRACE_MINUTES * 60_000;

export interface ServerCountNode {
  readonly metadata?: {
    readonly labels?: Readonly<Record<string, string>>;
    /** Stamped by the API server; the client library hands it over as a Date. */
    readonly creationTimestamp?: Date | string;
  };
  readonly spec?: { readonly taints?: ReadonlyArray<{ readonly key?: string }> };
  readonly status?: { readonly conditions?: ReadonlyArray<{ readonly type?: string; readonly status?: string }> };
}

export interface ServerCounts {
  /** Server nodes in the cluster, Ready or down — what HA sizes to. Not a join in progress. */
  readonly present: number;
  /** Server nodes whose Ready condition is True right now. */
  readonly ready: number;
}

/** A server is labelled `insula.host/node-role=server` or carries the control-plane taint. */
export function isServerNode(node: ServerCountNode): boolean {
  return node.metadata?.labels?.['insula.host/node-role'] === 'server'
    || (node.spec?.taints ?? []).some((t) => t.key === 'node-role.kubernetes.io/control-plane');
}

/** Count the server nodes in a Node list. Pure given `nowMs`. */
export function countServers(nodes: readonly ServerCountNode[], nowMs: number = Date.now()): ServerCounts {
  let present = 0;
  let ready = 0;
  for (const node of nodes) {
    if (!isServerNode(node)) continue;
    const isReady = (node.status?.conditions ?? []).find((c) => c.type === 'Ready')?.status === 'True';
    if (isReady) {
      ready++;
      present++;
      continue;
    }
    if (!isJoining(node, nowMs)) present++;
  }
  return { present, ready };
}

/** NotReady and younger than the join window. A missing or unreadable timestamp is not joining. */
function isJoining(node: ServerCountNode, nowMs: number): boolean {
  const created = node.metadata?.creationTimestamp;
  if (created === undefined) return false;
  const createdMs = created instanceof Date ? created.getTime() : Date.parse(created);
  return Number.isFinite(createdMs) && nowMs - createdMs < JOIN_WINDOW_MS;
}

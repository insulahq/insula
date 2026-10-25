/**
 * Which existing server a join goes through (`insula bootstrap --server`).
 *
 * Any server works. Every server holds the same server token, a joining
 * server's etcd member-add is forwarded to the leader by whichever member
 * receives it, and the new node admits every peer the target reports before
 * k3s starts (bootstrap.sh verify_join_credentials). So there is no "right"
 * server, only a wrong one: a server that is down. Ready alone lags a dead
 * server by the node-monitor grace period, so the API port of each candidate
 * is also checked right now (`/ping`, unauthenticated, TLS verified against
 * the cluster CA).
 */

import { ApiError } from '../../shared/errors.js';
import type { JoinServerCandidate } from '@insula/api-contracts';

const V4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const PROBE_TIMEOUT_MS = 2000;

export interface JoinNodeShape {
  readonly metadata?: { readonly name?: string; readonly labels?: Readonly<Record<string, string>> };
  readonly spec?: { readonly podCIDRs?: readonly string[]; readonly unschedulable?: boolean };
  readonly status?: {
    readonly addresses?: ReadonlyArray<{ readonly type?: string; readonly address?: string }>;
    readonly conditions?: ReadonlyArray<{ type?: string; status?: string }>;
  };
}

/** A candidate plus what the join step needs to know about its network. */
export interface ServerCandidate extends JoinServerCandidate {
  /** ExternalIP ≠ InternalIP: pinned to a private underlay (--cluster-network-cidr). */
  readonly privateUnderlay: boolean;
}

export function isControlPlane(n: JoinNodeShape): boolean {
  const labels = n.metadata?.labels ?? {};
  return (
    labels['node-role.kubernetes.io/control-plane'] !== undefined ||
    labels['node-role.kubernetes.io/master'] !== undefined
  );
}

function v4Address(n: JoinNodeShape, type: 'InternalIP' | 'ExternalIP'): string | undefined {
  return (n.status?.addresses ?? []).find((a) => a.type === type && a.address && V4_RE.test(a.address))?.address;
}

/** Every server a join could target: control-plane nodes with an IPv4
 *  InternalIP (bootstrap.sh's --server is IPv4-only), sorted by name. Only when
 *  NO node carries a control-plane label (unlabelled legacy nodes) does any node
 *  qualify — never a known worker, which serves no :6443. */
export function serverCandidates(items: readonly JoinNodeShape[]): ServerCandidate[] {
  const anyLabelled = items.some(isControlPlane);
  return items
    .filter((n) => (anyLabelled ? isControlPlane(n) : true))
    .flatMap((n): ServerCandidate[] => {
      const ip = v4Address(n, 'InternalIP');
      if (!ip) return [];
      const externalIp = v4Address(n, 'ExternalIP');
      return [
        {
          name: n.metadata?.name ?? ip,
          ip,
          ready: (n.status?.conditions ?? []).find((c) => c.type === 'Ready')?.status === 'True',
          cordoned: n.spec?.unschedulable === true,
          answering: null,
          privateUnderlay: externalIp !== undefined && externalIp !== ip,
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Check each Ready candidate's API port. A candidate that is not Ready is not
 *  probed (it cannot be picked as the default anyway). */
export async function probeCandidates(
  candidates: readonly ServerCandidate[],
  probe: ((ip: string) => Promise<boolean | null>) | null,
): Promise<ServerCandidate[]> {
  if (!probe) return [...candidates];
  return Promise.all(
    candidates.map(async (c) => ({ ...c, answering: c.ready ? await probe(c.ip).catch(() => false) : null })),
  );
}

/** The default target among Ready servers: one whose API port answered beats
 *  one not checked, which beats one that did not answer; within each, an
 *  uncordoned server first (a cordon is about scheduling — a cordoned server
 *  still serves joins). Null when no server is Ready. */
export function defaultJoinTarget(candidates: readonly ServerCandidate[]): ServerCandidate | null {
  const ready = candidates.filter((c) => c.ready);
  for (const answering of [true, null, false] as const) {
    const tier = ready.filter((c) => c.answering === answering);
    const pick = tier.find((c) => !c.cordoned) ?? tier[0];
    if (pick) return pick;
  }
  return null;
}

/** The server the operator asked for, validated against the candidates. */
export function requestedJoinTarget(candidates: readonly ServerCandidate[], ip: string): ServerCandidate {
  const c = candidates.find((x) => x.ip === ip);
  if (!c) {
    throw new ApiError(
      'JOIN_TARGET_UNKNOWN',
      `${ip} is not a server of this cluster — a join can only go through one of its servers.`,
      400,
    );
  }
  if (!c.ready) {
    throw new ApiError('JOIN_TARGET_NOT_READY', `Server ${c.name} (${c.ip}) is not Ready — pick another server.`, 409);
  }
  return c;
}

/** GET https://<ip>:6443/ping with the cluster CA: true on k3s's "pong", false
 *  on anything else (refused, timed out, TLS not signed by the cluster CA),
 *  never throws. No credentials are sent. */
export async function probeApiPort(
  ip: string,
  ca: Buffer,
  port = 6443,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const https = await import('node:https');
  return new Promise<boolean>((resolve) => {
    const req = https.request(
      { hostname: ip, port, path: '/ping', method: 'GET', ca, timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(false));
    req.end();
  });
}

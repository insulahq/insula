/**
 * One pooled HTTP dispatcher per Kubernetes API endpoint, shared by every
 * `KubeConfig` in the process.
 *
 * `@kubernetes/client-node` 2.x builds a NEW undici `Agent` for every request
 * (`applySecurityAuthentication` → `createDispatcher`, which has no cache), so
 * every API call opened its own TCP connection and paid a full TLS handshake,
 * then threw the socket away. Measured on a three-node production cluster:
 * ~4 new apiserver connections per second per platform-api replica, and the
 * handshakes alone were a visible share of the node-to-node traffic.
 *
 * The backend constructs a `KubeConfig` in dozens of places, so fixing the
 * call sites one by one would never be finished. The dispatcher factory is the
 * one place every request passes through: wrapping it once, at startup, makes
 * all of them reuse keep-alive connections.
 *
 * What may be shared, and what may not: a dispatcher carries only TRANSPORT
 * state — the server, the CA it trusts, a client certificate if one is used,
 * proxy settings. The bearer token is a per-request header that
 * `applySecurityAuthentication` sets on the request context, not on the
 * dispatcher, so sharing one between two `KubeConfig`s that point at the same
 * server with the same TLS identity cannot leak a credential. The cache key is
 * exactly that transport identity; anything else gets its own dispatcher.
 *
 * `createDispatcher` is not part of the published typings (it is `private`),
 * so this is a patch of a library internal. It is guarded both ways: if a
 * future version renames it, `installK8sConnectionPool` reports `false` and
 * changes nothing (requests still work, just unpooled), and
 * `k8s-connection-pool.test.ts` fails loudly against the installed version.
 */
import { createHash } from 'node:crypto';
import * as k8s from '@kubernetes/client-node';

/** Beyond this many distinct endpoints, stop caching rather than grow. */
const MAX_POOLED_DISPATCHERS = 32;

interface ClusterLike {
  readonly server?: string;
  readonly proxyUrl?: string;
  readonly skipTLSVerify?: boolean;
}

type AgentOptionsLike = Record<string, unknown>;
type CreateDispatcher = (cluster: ClusterLike | null, agentOptions: AgentOptionsLike) => unknown;

const pool = new Map<string, unknown>();
let installed = false;

function digest(value: unknown): string {
  if (value === undefined || value === null) return '-';
  const h = createHash('sha256');
  const feed = (v: unknown): void => {
    if (Buffer.isBuffer(v)) h.update(v);
    else if (Array.isArray(v)) v.forEach(feed);
    else h.update(String(v));
    h.update('\0');
  };
  feed(value);
  return h.digest('hex').slice(0, 16);
}

/**
 * The transport identity of a request: everything that decides which socket
 * may carry it. Two requests with equal keys can share a connection.
 */
export function dispatcherKey(cluster: ClusterLike | null, agentOptions: AgentOptionsLike): string {
  return [
    cluster?.server ?? '-',
    cluster?.proxyUrl ?? '-',
    cluster?.skipTLSVerify ? 'insecure' : 'verify',
    String(agentOptions.rejectUnauthorized ?? '-'),
    String(agentOptions.servername ?? '-'),
    digest(agentOptions.ca),
    digest(agentOptions.cert),
    digest(agentOptions.key),
    digest(agentOptions.pfx),
    digest(agentOptions.passphrase),
  ].join('|');
}

/**
 * Wrap `KubeConfig.prototype.createDispatcher` with a process-wide cache.
 * Idempotent. Returns true when pooling is active.
 */
export function installK8sConnectionPool(
  log: { warn: (msg: string) => void } = console,
): boolean {
  if (installed) return true;
  const proto = k8s.KubeConfig.prototype as unknown as { createDispatcher?: CreateDispatcher };
  const original = proto.createDispatcher;
  if (typeof original !== 'function') {
    log.warn('[k8s-connection-pool] KubeConfig.createDispatcher not found — Kubernetes API requests stay unpooled');
    return false;
  }
  proto.createDispatcher = function pooledCreateDispatcher(this: unknown, cluster, agentOptions) {
    const key = dispatcherKey(cluster, agentOptions ?? {});
    const hit = pool.get(key);
    if (hit !== undefined) return hit;
    const dispatcher = original.call(this, cluster, agentOptions);
    if (dispatcher !== undefined && pool.size < MAX_POOLED_DISPATCHERS) pool.set(key, dispatcher);
    return dispatcher;
  };
  installed = true;
  return true;
}

/** Number of pooled dispatchers. For tests and diagnostics. */
export function pooledDispatcherCount(): number {
  return pool.size;
}

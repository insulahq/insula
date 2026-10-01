/**
 * The cluster's live IngressRoutes, indexed by the Traefik service label
 * each route produces — the lookup that names route-scope traffic series.
 *
 * One cluster-wide list serves every caller: the index is only ever consulted
 * for labels already present in a frame, and a frame is already confined to
 * what its caller may see. Held for a short TTL so a dashboard refreshing
 * several charts costs one API read, and bounded by a timeout so a slow API
 * server costs at most that long once per TTL window — the caller then falls
 * back to its old names instead of waiting.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { INGRESSROUTE_PLURAL, TRAEFIK_GROUP, TRAEFIK_VERSION } from '../ingress-routes/traefik-types.js';
import { indexLiveRoutes, liveRoutesFromList, type LiveRoute } from './traefik-routes.js';

export const LIVE_ROUTES_TTL_MS = 30_000;
export const LIVE_ROUTES_TIMEOUT_MS = 3_000;

export type LiveRouteIndex = ReadonlyMap<string, LiveRoute>;
export type LiveRouteSource = () => Promise<LiveRouteIndex>;

export interface LiveRouteSourceOptions {
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

type Cached =
  | { readonly at: number; readonly index: LiveRouteIndex }
  | { readonly at: number; readonly error: unknown };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`IngressRoute list timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * A cached, de-duplicated reader over `list`. A failure is remembered for the
 * same TTL as a success, so an unreachable API server costs one attempt per
 * window rather than one per chart.
 */
export function createLiveRouteSource(
  list: () => Promise<unknown>,
  opts: LiveRouteSourceOptions = {},
): LiveRouteSource {
  const ttlMs = opts.ttlMs ?? LIVE_ROUTES_TTL_MS;
  const timeoutMs = opts.timeoutMs ?? LIVE_ROUTES_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  let cached: Cached | null = null;
  let inflight: Promise<LiveRouteIndex> | null = null;
  // The underlying request, kept until it settles. A timeout abandons a read
  // but cannot cancel it, so the next window re-joins the same request rather
  // than opening another — at most one is ever outstanding.
  let request: Promise<unknown> | null = null;

  const startRequest = (): Promise<unknown> => {
    request ??= Promise.resolve().then(list).finally(() => { request = null; });
    return request;
  };

  const read = async (): Promise<LiveRouteIndex> => {
    try {
      const body = await withTimeout(startRequest(), timeoutMs);
      const index = indexLiveRoutes(liveRoutesFromList(body));
      cached = { at: now(), index };
      return index;
    } catch (error) {
      cached = { at: now(), error };
      throw error;
    } finally {
      inflight = null;
    }
  };

  return () => {
    if (cached && now() - cached.at < ttlMs) {
      return 'index' in cached ? Promise.resolve(cached.index) : Promise.reject(cached.error);
    }
    inflight ??= read();
    return inflight;
  };
}

/** Lists every IngressRoute in the cluster; clients are created on first use. */
export function k8sIngressRouteLister(kubeconfigPath: () => string | undefined): () => Promise<unknown> {
  let clients: K8sClients | null = null;
  return async () => {
    clients ??= createK8sClients(kubeconfigPath());
    return clients.custom.listClusterCustomObject({
      group: TRAEFIK_GROUP,
      version: TRAEFIK_VERSION,
      plural: INGRESSROUTE_PLURAL,
    });
  };
}

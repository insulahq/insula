/**
 * Per-client concurrency cap on the platform's compressing routes — the
 * runtime half of k8s/base/traefik/middlewares-global.yaml.
 *
 * Every route that uses the shared `compress@traefik` Middleware must run
 * `inflight-per-client@traefik` directly before it, so one client cannot hold
 * an unbounded number of compressed responses open (each holds a compression
 * writer; on production that OOM-killed the Traefik DaemonSet).
 *
 * The git manifests carry the cap, but three of these IngressRoutes are
 * `kustomize.toolkit.fluxcd.io/reconcile: disabled` (R16 seed-then-disown):
 * Flux seeds them once and never updates them, so a manifest change reaches
 * FRESH installs only. This converges running clusters on boot. The other
 * reconcilers that own these routes spread each route when they patch, so the
 * cap survives an engine switch or an apex rename once it is in.
 */
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import { MERGE_PATCH } from './k8s-patch.js';

export interface MiddlewareRef {
  readonly name?: string;
  readonly namespace?: string;
}

export const COMPRESS_MIDDLEWARE: Readonly<Required<MiddlewareRef>> = { name: 'compress', namespace: 'traefik' };
export const INFLIGHT_MIDDLEWARE: Readonly<Required<MiddlewareRef>> = {
  name: 'inflight-per-client',
  namespace: 'traefik',
};

/** The Flux-disowned IngressRoutes that use `compress` (see the manifests). */
export const DISOWNED_COMPRESS_ROUTES: ReadonlyArray<{ readonly namespace: string; readonly name: string }> = [
  { namespace: 'mail', name: 'platform-webmail-ingress' },
  { namespace: 'mail', name: 'stalwart-webadmin' },
  { namespace: 'platform-system', name: 'tunnel-anchor' },
];

const is = (m: MiddlewareRef, want: Required<MiddlewareRef>): boolean =>
  m.name === want.name && (m.namespace ?? '') === want.namespace;

/**
 * Pure: the middleware list with `inflight-per-client` directly before the
 * first `compress`. A list without `compress` is returned unchanged; a cap
 * elsewhere in the list is moved, never duplicated.
 */
export function withInflightBeforeCompress(
  middlewares: ReadonlyArray<MiddlewareRef>,
): { readonly middlewares: MiddlewareRef[]; readonly changed: boolean } {
  const at = middlewares.findIndex((m) => is(m, COMPRESS_MIDDLEWARE));
  if (at < 0 || (at > 0 && is(middlewares[at - 1], INFLIGHT_MIDDLEWARE))) {
    return { middlewares: [...middlewares], changed: false };
  }
  const rest = middlewares.filter((m) => !is(m, INFLIGHT_MIDDLEWARE));
  const compressAt = rest.findIndex((m) => is(m, COMPRESS_MIDDLEWARE));
  return {
    middlewares: [...rest.slice(0, compressAt), { ...INFLIGHT_MIDDLEWARE }, ...rest.slice(compressAt)],
    changed: true,
  };
}

interface Route {
  readonly middlewares?: MiddlewareRef[];
  readonly [key: string]: unknown;
}
interface IngressRouteObject {
  readonly metadata?: { readonly resourceVersion?: string };
  readonly spec?: { readonly routes?: Route[] };
}

/**
 * Converge the disowned compressing routes. Best-effort and idempotent: a
 * missing route or a failed patch is logged and skipped; the next boot tries
 * again. Nothing is patched until the Middleware itself exists — Traefik
 * drops a router that references a missing Middleware, so referencing it
 * before Flux has applied it (a boot racing the release apply) would take
 * webmail and the Stalwart routes down. The patch carries the resourceVersion it was computed from, so a
 * concurrent writer (e.g. a webmail engine switch) wins with a 409 instead of
 * being silently overwritten — MERGE_PATCH replaces the whole routes array.
 */
export async function reconcileCompressRouteBounds(
  custom: k8s.CustomObjectsApi,
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<{ readonly patched: string[] }> {
  const patched: string[] = [];
  try {
    await custom.getNamespacedCustomObject({
      group: 'traefik.io',
      version: 'v1alpha1',
      namespace: INFLIGHT_MIDDLEWARE.namespace,
      plural: 'middlewares',
      name: INFLIGHT_MIDDLEWARE.name,
    } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0]);
  } catch (err) {
    log.warn(
      { err, middleware: `${INFLIGHT_MIDDLEWARE.namespace}/${INFLIGHT_MIDDLEWARE.name}` },
      'traefik: concurrency-cap Middleware not present yet — routes left as they are until the next boot',
    );
    return { patched };
  }
  for (const ref of DISOWNED_COMPRESS_ROUTES) {
    const id = `${ref.namespace}/${ref.name}`;
    try {
      const current = (await custom.getNamespacedCustomObject({
        group: 'traefik.io',
        version: 'v1alpha1',
        namespace: ref.namespace,
        plural: 'ingressroutes',
        name: ref.name,
      } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0])) as IngressRouteObject;
      const routes = current.spec?.routes ?? [];
      const next = routes.map((r) => withInflightBeforeCompress(r.middlewares ?? []));
      if (!next.some((n) => n.changed)) continue;
      const newRoutes = routes.map((r, i) => (next[i].changed ? { ...r, middlewares: next[i].middlewares } : r));
      await custom.patchNamespacedCustomObject(
        {
          group: 'traefik.io',
          version: 'v1alpha1',
          namespace: ref.namespace,
          plural: 'ingressroutes',
          name: ref.name,
          body: {
            ...(current.metadata?.resourceVersion
              ? { metadata: { resourceVersion: current.metadata.resourceVersion } }
              : {}),
            spec: { routes: newRoutes },
          },
        } as unknown as Parameters<typeof custom.patchNamespacedCustomObject>[0],
        MERGE_PATCH,
      );
      patched.push(id);
      log.info({ ingressRoute: id }, 'traefik: per-client concurrency cap converged before compress');
    } catch (err) {
      log.warn({ err, ingressRoute: id }, 'traefik: could not converge the concurrency cap on this route — retried next boot');
    }
  }
  return { patched };
}

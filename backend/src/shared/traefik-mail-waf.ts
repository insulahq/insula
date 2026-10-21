/**
 * The edge guards on the mail web surfaces — webmail and the Stalwart host
 * (web admin + JMAP) — the runtime half of their manifests.
 *
 * Every other platform UI runs `crowdsec` first and the WAF (`waf-body-limit`
 * then `modsecurity-crs`) after its auth gate (system-settings/
 * ingress-reconciler.ts PANEL_EDGE_GUARDS). These two IngressRoutes had
 * neither: webmail's login and the Stalwart admin login were reachable by any
 * address CrowdSec had banned, with no request inspection at all.
 *
 * Both IngressRoutes are `kustomize.toolkit.fluxcd.io/reconcile: disabled`
 * (R16 seed-then-disown), so the manifest change reaches fresh installs only;
 * this converges running clusters, on every webmail-router tick.
 *
 * What a mailbox owner writes reads as injection to the CRS, so the two routes
 * that carry it — the JMAP API and webmail — get the WAF only together with
 * the exclusion that lets mail through (modsec-crs 9000118 for the Stalwart
 * host, 9000119 for webmail). Those exclusions are host-scoped, rendered with
 * the cluster's apex, and loaded by the sidecar only when it restarts. So the
 * WAF goes onto such a route when, and only when, the sidecar RUNS an
 * exclusion whose host pattern matches that route's host: a renamed webmail
 * host, or a boot before the release's exclusions are live, keeps CrowdSec
 * without the WAF instead of refusing ordinary mail. The Stalwart admin route
 * carries no mail and always gets both.
 *
 * ONE carve-out, by route: JMAP blob upload. An attachment is a raw body of up
 * to Stalwart's upload limit (100 MB), and `waf-body-limit` refuses anything
 * over the sidecar's 12.5 MiB. The upload route keeps CrowdSec and Stalwart's
 * own authentication; the JMAP route gets the WAF only once it exists.
 */
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import { MERGE_PATCH } from './k8s-patch.js';
import { extractHostFromMatch } from './traefik-host-reconcile.js';
import { COMPRESS_MIDDLEWARE, INFLIGHT_MIDDLEWARE, type MiddlewareRef } from './traefik-compress-bounds.js';
import {
  MODSEC_DEPLOY_NAME,
  WAF_EXCLUSION_CM_NAME,
  WAF_EXCLUSION_CM_NAMESPACE,
  WAF_EXCLUSION_HASH_ANNOTATION,
  WAF_STATIC_EXCLUSION_CM_KEY,
  WAF_STATIC_EXCLUSION_CM_NAME,
  modsecDeployHash,
} from '../modules/waf-rule-exclusions/reconciler.js';

export const CROWDSEC_MIDDLEWARE: Readonly<Required<MiddlewareRef>> = { name: 'crowdsec', namespace: 'traefik' };
export const WAF_BODY_LIMIT_MIDDLEWARE: Readonly<Required<MiddlewareRef>> = { name: 'waf-body-limit', namespace: 'traefik' };
export const WAF_MIDDLEWARE: Readonly<Required<MiddlewareRef>> = { name: 'modsecurity-crs', namespace: 'traefik' };

export const MAIL_WAF_ROUTES: ReadonlyArray<{ readonly namespace: string; readonly name: string }> = [
  { namespace: 'mail', name: 'platform-webmail-ingress' },
  { namespace: 'mail', name: 'stalwart-webadmin' },
];

const WEBMAIL_ROUTE = 'platform-webmail-ingress';
const STALWART_ROUTE = 'stalwart-webadmin';
/** The exclusion each message-carrying route needs (exclusion-rules-configmap.yaml). */
export const JMAP_EXCLUSION_ID = '9000118';
export const WEBMAIL_EXCLUSION_ID = '9000119';
const JMAP_UPLOAD_PREFIX = '/jmap/upload';
/**
 * Above the JMAP route, whose default priority is its rule's length (~90 with
 * a long apex). Traefik orders routers by priority, then rule length — without
 * this the shorter upload rule loses to `PathPrefix(`/jmap`)` and the carve-out
 * never matches. Higher than the panels' 101 because this rule's competitor
 * grows with the apex.
 */
export const JMAP_UPLOAD_PRIORITY = 1000;

const is = (m: MiddlewareRef, want: Required<MiddlewareRef>): boolean =>
  m.name === want.name && (m.namespace ?? '') === want.namespace;
const isGuard = (m: MiddlewareRef): boolean =>
  is(m, CROWDSEC_MIDDLEWARE) || is(m, WAF_BODY_LIMIT_MIDDLEWARE) || is(m, WAF_MIDDLEWARE);
const hasWaf = (list: ReadonlyArray<MiddlewareRef> | undefined): boolean => (list ?? []).some((m) => is(m, WAF_MIDDLEWARE));

/**
 * Pure: `crowdsec` first, and — when `waf` — the body cap then the WAF
 * directly before `inflight-per-client` (else before `compress`, else last).
 * Everything between, the auth gate or the CORS headers, runs before the WAF,
 * as on the panels: a request refused by the WAF still carries CORS, so the
 * webmail SPA reports a refusal rather than a network error.
 */
export function withEdgeGuards(
  middlewares: ReadonlyArray<MiddlewareRef>,
  opts: { readonly waf: boolean },
): { readonly middlewares: MiddlewareRef[]; readonly changed: boolean } {
  const rest = middlewares.filter((m) => !isGuard(m));
  const inflightAt = rest.findIndex((m) => is(m, INFLIGHT_MIDDLEWARE));
  const compressAt = rest.findIndex((m) => is(m, COMPRESS_MIDDLEWARE));
  const at = inflightAt >= 0 ? inflightAt : compressAt >= 0 ? compressAt : rest.length;
  const next: MiddlewareRef[] = [
    { ...CROWDSEC_MIDDLEWARE },
    ...rest.slice(0, at),
    ...(opts.waf ? [{ ...WAF_BODY_LIMIT_MIDDLEWARE }, { ...WAF_MIDDLEWARE }] : []),
    ...rest.slice(at),
  ];
  const key = (list: ReadonlyArray<MiddlewareRef>) => list.map((m) => `${m.namespace ?? ''}/${m.name ?? ''}`).join(',');
  return { middlewares: next, changed: key(next) !== key(middlewares) };
}

interface Route {
  readonly match?: string;
  readonly middlewares?: MiddlewareRef[];
  readonly priority?: number;
  readonly [key: string]: unknown;
}

/**
 * Which hosts the running sidecar lets mail through on: exclusion id → its
 * host pattern. Null when that is not known (a read failed, the sidecar has
 * not rolled onto the current exclusions yet) — the converger then leaves
 * the WAF on each message-carrying route exactly as it is.
 */
export type LiveExclusions = ReadonlyMap<string, RegExp> | null;

const isUploadRoute = (r: Route): boolean => (r.match ?? '').includes(`PathPrefix(\`${JMAP_UPLOAD_PREFIX}\`)`);
const isJmapRoute = (r: Route): boolean => !isUploadRoute(r) && (r.match ?? '').includes('PathPrefix(`/jmap`)');

function covered(live: LiveExclusions, id: string, route: Route): boolean | null {
  if (!live) return null;
  const host = extractHostFromMatch(route.match ?? '');
  const pattern = live.get(id);
  return Boolean(host && pattern?.test(host));
}

/**
 * Pure: the IngressRoute's routes with the guards in place. For the Stalwart
 * route, the JMAP upload carve-out is derived from the JMAP route — same Host,
 * backend and CORS headers — when it is not there yet.
 */
export function withMailEdgeGuards(
  name: string,
  routes: ReadonlyArray<Route>,
  live: LiveExclusions,
): { readonly routes: Route[]; readonly changed: boolean } {
  let list: Route[] = [...routes];
  let changed = false;

  // The carve-out first: the JMAP route may take the WAF only beside it.
  if (name === STALWART_ROUTE && !list.some(isUploadRoute)) {
    const jmapAt = list.findIndex(isJmapRoute);
    const host = jmapAt >= 0 ? extractHostFromMatch(list[jmapAt].match ?? '') : null;
    if (host) {
      const jmap = list[jmapAt];
      const upload: Route = {
        ...jmap,
        match: `Host(\`${host}\`) && PathPrefix(\`${JMAP_UPLOAD_PREFIX}\`)`,
        priority: JMAP_UPLOAD_PRIORITY,
        middlewares: withEdgeGuards(jmap.middlewares ?? [], { waf: false }).middlewares,
      };
      list = [...list.slice(0, jmapAt), upload, ...list.slice(jmapAt)];
      changed = true;
    }
  }
  const uploadExists = list.some(isUploadRoute);

  const wafFor = (r: Route): boolean => {
    if (isUploadRoute(r)) return false;
    if (name === WEBMAIL_ROUTE) return covered(live, WEBMAIL_EXCLUSION_ID, r) ?? hasWaf(r.middlewares);
    if (isJmapRoute(r)) {
      if (!uploadExists) return false;
      return covered(live, JMAP_EXCLUSION_ID, r) ?? hasWaf(r.middlewares);
    }
    return true;
  };

  const guarded = list.map((r) => {
    const g = withEdgeGuards(r.middlewares ?? [], { waf: wafFor(r) });
    if (!g.changed) return r;
    changed = true;
    return { ...r, middlewares: g.middlewares };
  });
  return { routes: guarded, changed };
}

/**
 * Pure: exclusion id → host pattern, for the host-scoped rules in the static
 * exclusion file (`SecRule REQUEST_HEADERS:X-Forwarded-Host "@rx …"` followed
 * by its `"id:…`). A pattern that is not a valid JavaScript RegExp is left out.
 */
export function exclusionHostPatterns(conf: string): Map<string, RegExp> {
  const out = new Map<string, RegExp>();
  const rule = /SecRule REQUEST_HEADERS:X-Forwarded-Host "@rx ([^"]+)" \\\s*\n\s*"id:(\d+)/g;
  for (const m of conf.matchAll(rule)) {
    try {
      out.set(m[2], new RegExp(m[1]));
    } catch {
      // Not expressible here: that host simply does not count as covered.
    }
  }
  return out;
}

interface ConfigMapLike {
  readonly metadata?: { readonly annotations?: Record<string, string> };
  readonly data?: Record<string, string>;
}
interface DeploymentLike {
  readonly metadata?: { readonly generation?: number };
  readonly spec?: { readonly replicas?: number; readonly template?: { readonly metadata?: { readonly annotations?: Record<string, string> } } };
  readonly status?: {
    readonly observedGeneration?: number;
    readonly replicas?: number;
    readonly updatedReplicas?: number;
    readonly availableReplicas?: number;
  };
}

/**
 * The exclusions the sidecar RUNS: the static file's host patterns, provided
 * the modsec-crs pods were rolled onto it (their stamp is the one the WAF
 * exclusion reconciler computes from it, and no pod of an older template is
 * left). The file is Flux-applied and read only at pod start, so its content
 * alone says nothing about what the sidecar enforces.
 */
export async function liveMailExclusions(
  core: k8s.CoreV1Api,
  apps: k8s.AppsV1Api,
): Promise<LiveExclusions> {
  try {
    const read = (name: string) => core.readNamespacedConfigMap({
      name,
      namespace: WAF_EXCLUSION_CM_NAMESPACE,
    } as unknown as Parameters<typeof core.readNamespacedConfigMap>[0]) as Promise<ConfigMapLike>;
    const [staticCm, dynamicCm] = await Promise.all([read(WAF_STATIC_EXCLUSION_CM_NAME), read(WAF_EXCLUSION_CM_NAME)]);
    const staticContent = staticCm.data?.[WAF_STATIC_EXCLUSION_CM_KEY] ?? '';
    const renderedHash = dynamicCm.metadata?.annotations?.[WAF_EXCLUSION_HASH_ANNOTATION];
    if (!staticContent || !renderedHash) return null;
    const dep = (await apps.readNamespacedDeployment({
      name: MODSEC_DEPLOY_NAME,
      namespace: WAF_EXCLUSION_CM_NAMESPACE,
    } as unknown as Parameters<typeof apps.readNamespacedDeployment>[0])) as DeploymentLike;
    const stamped = dep.spec?.template?.metadata?.annotations?.[WAF_EXCLUSION_HASH_ANNOTATION]
      === modsecDeployHash(renderedHash, staticContent);
    const want = dep.spec?.replicas ?? 1;
    const st = dep.status ?? {};
    const rolledOut = (st.observedGeneration ?? 0) >= (dep.metadata?.generation ?? 0)
      && (st.updatedReplicas ?? 0) >= want
      && (st.replicas ?? 0) === (st.updatedReplicas ?? 0)
      && (st.availableReplicas ?? 0) >= 1;
    return stamped && rolledOut ? exclusionHostPatterns(staticContent) : null;
  } catch {
    return null;
  }
}

interface IngressRouteObject {
  readonly metadata?: { readonly resourceVersion?: string };
  readonly spec?: { readonly routes?: Route[] };
}

export interface MailEdgeGuardClients {
  readonly custom: k8s.CustomObjectsApi;
  readonly core: k8s.CoreV1Api;
  readonly apps: k8s.AppsV1Api;
}

/**
 * Converge the mail routes. Best-effort and idempotent: a missing route or a
 * failed patch is logged and skipped; the next tick tries again. Nothing is
 * patched until all three Middlewares exist — Traefik drops a router that
 * references a missing one, so a boot racing the release apply would take
 * webmail and the Stalwart host down. The patch carries the resourceVersion
 * it was computed from, so a concurrent writer (a webmail engine switch) wins
 * with a 409 instead of being overwritten — MERGE_PATCH replaces the whole
 * routes array.
 */
export async function reconcileMailEdgeGuards(
  clients: MailEdgeGuardClients,
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<{ readonly patched: string[] }> {
  const { custom } = clients;
  const patched: string[] = [];
  for (const mw of [CROWDSEC_MIDDLEWARE, WAF_BODY_LIMIT_MIDDLEWARE, WAF_MIDDLEWARE]) {
    try {
      await custom.getNamespacedCustomObject({
        group: 'traefik.io',
        version: 'v1alpha1',
        namespace: mw.namespace,
        plural: 'middlewares',
        name: mw.name,
      } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0]);
    } catch (err) {
      log.warn(
        { err, middleware: `${mw.namespace}/${mw.name}` },
        'traefik: edge-guard Middleware could not be read — mail routes left as they are until the next tick',
      );
      return { patched };
    }
  }
  const live = await liveMailExclusions(clients.core, clients.apps);
  for (const ref of MAIL_WAF_ROUTES) {
    const id = `${ref.namespace}/${ref.name}`;
    try {
      const current = (await custom.getNamespacedCustomObject({
        group: 'traefik.io',
        version: 'v1alpha1',
        namespace: ref.namespace,
        plural: 'ingressroutes',
        name: ref.name,
      } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0])) as IngressRouteObject;
      const next = withMailEdgeGuards(ref.name, current.spec?.routes ?? [], live);
      if (!next.changed) continue;
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
            spec: { routes: next.routes },
          },
        } as unknown as Parameters<typeof custom.patchNamespacedCustomObject>[0],
        MERGE_PATCH,
      );
      patched.push(id);
      log.info(
        { ingressRoute: id, waf: next.routes.map((r) => hasWaf(r.middlewares)) },
        'traefik: CrowdSec + WAF converged on a mail route',
      );
    } catch (err) {
      log.warn({ err, ingressRoute: id }, 'traefik: could not converge the edge guards on this route — retried next tick');
    }
  }
  return { patched };
}

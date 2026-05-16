import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  TRAEFIK_GROUP,
  TRAEFIK_VERSION,
  INGRESSROUTE_PLURAL,
  buildMiddleware,
  redirectRegexSpec,
} from '../ingress-routes/traefik-types.js';
import {
  applyMiddleware,
  deleteMiddleware,
  isK8sNotFound,
} from '../ingress-routes/traefik-apply.js';

/**
 * IngressRoute suspend / resume — when a tenant is suspended, redirect
 * every tenant route to the cluster-wide `platform-suspended` page via
 * a per-IngressRoute RedirectRegex Middleware; on resume, drop the
 * Middleware reference and delete the Middleware CR.
 *
 * Why a Middleware (and not a separate IngressRoute or backend swap):
 *   - Reuses the existing IngressRoute → cert-manager Certificate
 *     binding, so we don't trigger a re-issue storm on resume.
 *   - One Traefik Middleware per IngressRoute keeps the orphan-cleanup
 *     story local — `r-${routeName.slice(0,8)}-suspend` is enough to
 *     identify what we created.
 *   - Suspend state is recorded as an annotation on the IngressRoute so
 *     the tenant ingress reconciler (domains/k8s-ingress.ts) can skip
 *     namespaces during their suspend window without re-reading state
 *     from the DB.
 *
 * Idempotent: calling suspend on an already-suspended IngressRoute is a
 * no-op; same for resume on an active one. The reconcile-vs-suspend
 * race is broken by `isNamespaceIngressSuspended` which the tenant
 * reconciler consults before applying.
 */

const SUSPENDED_MARKER_ANNOTATION = 'platform.io/suspended';
// Platform-wide suspended URL — the `platform-suspended` Deployment /
// Service / IngressRoute in the `platform` namespace host this page.
const SUSPENDED_REDIRECT_URL_ENV = 'SUSPENDED_REDIRECT_URL';
const SUSPENDED_REDIRECT_URL_DEFAULT = 'https://suspended.platform.local/';

// IngressRoute shape we care about — just the fields we read/mutate.
type IngressRouteSpec = {
  readonly metadata?: {
    readonly name?: string;
    readonly namespace?: string;
    readonly resourceVersion?: string;
    readonly annotations?: Record<string, string>;
  };
  readonly spec?: {
    readonly routes?: Array<{
      readonly match?: string;
      readonly kind?: string;
      readonly priority?: number;
      readonly middlewares?: Array<{ name: string; namespace?: string }>;
      readonly services?: Array<{ name: string; port: number; namespace?: string }>;
    }>;
    readonly entryPoints?: string[];
    readonly tls?: Record<string, unknown>;
  };
};

function suspendMiddlewareName(routeName: string): string {
  // Match the convention in traefik-types.middlewareName: 8-char prefix
  // keeps the K8s 63-char limit comfortable even with long namespace
  // prefixes added during ownership labelling.
  return `r-${routeName.slice(0, 8)}-suspend`;
}

/**
 * Read-modify-replace an IngressRoute custom object with retry-on-409.
 * k8s uses optimistic concurrency via metadata.resourceVersion; if two
 * callers race (admin API + expiry-checker cron suspending the same
 * tenant), the second replace returns 409. Re-read and retry.
 */
async function readModifyReplaceIngressRoute(
  custom: import('@kubernetes/client-node').CustomObjectsApi,
  namespace: string,
  name: string,
  mutate: (current: IngressRouteSpec) => IngressRouteSpec,
): Promise<void> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const current = (await custom.getNamespacedCustomObject({
      group: TRAEFIK_GROUP,
      version: TRAEFIK_VERSION,
      namespace,
      plural: INGRESSROUTE_PLURAL,
      name,
    })) as IngressRouteSpec;
    const updated = mutate(current);
    try {
      await custom.replaceNamespacedCustomObject({
        group: TRAEFIK_GROUP,
        version: TRAEFIK_VERSION,
        namespace,
        plural: INGRESSROUTE_PLURAL,
        name,
        body: updated as unknown as Record<string, unknown>,
      });
      return;
    } catch (err) {
      const status = (err as { statusCode?: number; code?: number; body?: { code?: number } }).statusCode
        ?? (err as { code?: number }).code
        ?? (err as { body?: { code?: number } }).body?.code;
      const isConflict = status === 409
        || String((err as Error).message ?? '').includes('HTTP-Code: 409')
        || String((err as Error).message ?? '').includes('"code":409');
      if (!isConflict || attempt === MAX_ATTEMPTS) throw err;
      console.warn(`[ingress-suspend] 409 conflict on ${namespace}/${name}, retry ${attempt}/${MAX_ATTEMPTS}`);
    }
  }
}

async function listNamespaceIngressRoutes(
  custom: import('@kubernetes/client-node').CustomObjectsApi,
  namespace: string,
): Promise<IngressRouteSpec[]> {
  try {
    const res = await custom.listNamespacedCustomObject({
      group: TRAEFIK_GROUP,
      version: TRAEFIK_VERSION,
      namespace,
      plural: INGRESSROUTE_PLURAL,
    });
    return ((res as { items?: IngressRouteSpec[] }).items) ?? [];
  } catch (err: unknown) {
    if (isK8sNotFound(err)) return [];
    throw err;
  }
}

/**
 * Suspend every IngressRoute in the namespace by:
 *   1. Creating a per-route RedirectRegex Middleware that 307s every
 *      path to the platform-suspended URL.
 *   2. Patching every route's middlewares[] to include the new
 *      Middleware FIRST (so it short-circuits before the route's
 *      original middleware chain reaches the upstream).
 *   3. Stamping a `platform.io/suspended: true` annotation so resume
 *      can find what to roll back and the tenant reconciler can
 *      detect the suspended state without DB lookups.
 */
export async function suspendNamespaceIngresses(
  k8s: K8sClients,
  namespace: string,
): Promise<{ suspended: string[] }> {
  const redirectUrl = process.env[SUSPENDED_REDIRECT_URL_ENV] ?? SUSPENDED_REDIRECT_URL_DEFAULT;

  const routes = await listNamespaceIngressRoutes(k8s.custom, namespace);
  const suspended: string[] = [];

  for (const ing of routes) {
    const name = ing.metadata?.name;
    if (!name) continue;
    const annotations = ing.metadata?.annotations ?? {};
    if (annotations[SUSPENDED_MARKER_ANNOTATION] === 'true') {
      // Already suspended — skip but keep in the result for caller stats.
      suspended.push(name);
      continue;
    }

    // 1. Apply the RedirectRegex Middleware first so the IngressRoute
    //    patch references something Traefik has already loaded.
    const mwName = suspendMiddlewareName(name);
    const middleware = buildMiddleware({
      name: mwName,
      namespace,
      // `.*` catches every path; replacement is the static suspended URL
      // verbatim. `permanent: false` → 307 (temporary) so browsers
      // re-check on resume.
      spec: redirectRegexSpec({
        regex: '.*',
        replacement: redirectUrl,
        permanent: false,
      }),
      labels: {
        'hosting-platform/suspend': 'true',
        'hosting-platform/ingressroute-name': name,
      },
    });
    await applyMiddleware(k8s.custom, middleware);

    // 2. Patch the IngressRoute: add the suspend Middleware ref to every
    //    route's middlewares list (front of list so it wins). Stamp the
    //    suspend marker annotation.
    await readModifyReplaceIngressRoute(k8s.custom, namespace, name, (current) => {
      const nextRoutes = (current.spec?.routes ?? []).map((r) => {
        const existing = r.middlewares ?? [];
        const alreadyHas = existing.some(
          (m) => m.name === mwName && (m.namespace ?? namespace) === namespace,
        );
        if (alreadyHas) return r;
        return {
          ...r,
          middlewares: [{ name: mwName, namespace }, ...existing],
        };
      });
      return {
        ...current,
        metadata: {
          ...current.metadata,
          annotations: {
            ...(current.metadata?.annotations ?? {}),
            [SUSPENDED_MARKER_ANNOTATION]: 'true',
          },
        },
        spec: {
          ...current.spec,
          routes: nextRoutes,
        },
      };
    });
    suspended.push(name);
  }

  return { suspended };
}

/**
 * Resume by dropping the suspend Middleware references + deleting the
 * Middleware CRs + clearing the marker annotation.
 */
export async function resumeNamespaceIngresses(
  k8s: K8sClients,
  namespace: string,
): Promise<{ resumed: string[] }> {
  const routes = await listNamespaceIngressRoutes(k8s.custom, namespace);
  const resumed: string[] = [];

  for (const ing of routes) {
    const name = ing.metadata?.name;
    if (!name) continue;
    const annotations = ing.metadata?.annotations ?? {};
    if (annotations[SUSPENDED_MARKER_ANNOTATION] !== 'true') continue;

    const mwName = suspendMiddlewareName(name);

    // 1. Strip the suspend Middleware ref from every route + clear the
    //    marker annotation.
    await readModifyReplaceIngressRoute(k8s.custom, namespace, name, (current) => {
      const nextAnnotations: Record<string, string> = { ...(current.metadata?.annotations ?? {}) };
      delete nextAnnotations[SUSPENDED_MARKER_ANNOTATION];
      const nextRoutes = (current.spec?.routes ?? []).map((r) => ({
        ...r,
        middlewares: (r.middlewares ?? []).filter(
          (m) => !(m.name === mwName && (m.namespace ?? namespace) === namespace),
        ),
      }));
      return {
        ...current,
        metadata: { ...current.metadata, annotations: nextAnnotations },
        spec: { ...current.spec, routes: nextRoutes },
      };
    });

    // 2. Delete the now-orphan Middleware. Safe to ignore 404 — the
    //    Middleware may have been GC'd by an earlier resume attempt.
    await deleteMiddleware(k8s.custom, namespace, mwName);

    resumed.push(name);
  }

  return { resumed };
}

/**
 * Is any IngressRoute in this namespace currently suspended? Used by
 * the tenant ingress reconciler (domains/k8s-ingress.ts) to skip
 * namespaces during their suspend window so it doesn't accidentally
 * reset the suspend by overwriting routes.
 */
export async function isNamespaceIngressSuspended(
  k8s: K8sClients,
  namespace: string,
): Promise<boolean> {
  const routes = await listNamespaceIngressRoutes(k8s.custom, namespace);
  return routes.some(
    (ing) => ing.metadata?.annotations?.[SUSPENDED_MARKER_ANNOTATION] === 'true',
  );
}

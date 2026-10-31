/**
 * Route target classification — the single answer to "should this row become
 * an IngressRoute, and what does it point at?".
 *
 * This predicate used to be inlined as `(r.deploymentId || r.privateWorkerId)`
 * in three places: twice in the domains reconciler and once in
 * `buildAllRouteSpecs`. All three had to agree, and all three had to change
 * together to let a redirect-only route through — the kind of duplication that
 * silently half-implements a feature (the route would materialise but its
 * redirect Middleware would not, or vice versa). One function, three callers.
 */

/** The subset of an `ingress_routes` row that decides where a route points. */
export interface RouteTargetFields {
  readonly deploymentId: string | null;
  readonly privateWorkerId: string | null;
  readonly redirectUrl: string | null;
}

/**
 * A route is redirect-only when it sends visitors elsewhere and has nothing of
 * its own to serve. It still gets a real IngressRoute — the redirect Middleware
 * answers with a 301 before the backend would ever be consulted.
 */
export function isRedirectOnly(route: RouteTargetFields): boolean {
  return Boolean(route.redirectUrl) && !route.deploymentId && !route.privateWorkerId;
}

/**
 * A route is routable when it has something to serve OR somewhere to send
 * visitors. A row with neither is half-configured and is still skipped: it
 * would produce an IngressRoute that can only 503.
 */
export function isRoutable(route: RouteTargetFields): boolean {
  return Boolean(route.deploymentId || route.privateWorkerId || route.redirectUrl);
}

/** The subset of an `ingress_routes` row that decides whether it is served at all. */
export interface ServedRouteFields extends RouteTargetFields {
  readonly status: string;
  readonly enabled: boolean;
}

/**
 * A route is served — gets a router — when it is set up (`status`), switched
 * on (`enabled`) and routable. The domains reconciler and `buildAllRouteSpecs`
 * must agree on this, or a switched-off route would keep its Middlewares while
 * losing its router (or the reverse).
 */
export function isServed(route: ServedRouteFields): boolean {
  return route.enabled && route.status === 'active' && isRoutable(route);
}

/**
 * An ingress-route traffic series, named for what it serves.
 *
 * The live route a series was matched to (see traefik-routes.ts) gives the
 * host and path; the `ingress_routes` row for that host and path gives the
 * deployment or private worker behind it. Approved formats:
 *
 *   tenant panel   www.example.test → website
 *   admin          www.example.test → website · <Tenant>
 *   with a path    example.test/shop → shop
 *   several hosts  example.test +1 → website
 *   :80 router     www.example.test (http → https redirect)
 *   ACME solver    Certificate validation
 *   no row/target  www.example.test → <services[0].name>
 *
 * `null` means "not mine to name" — the caller keeps its existing fallback.
 * Only tenant namespaces are named here; platform, mail and the rest keep
 * the names they already had.
 */

import { wwwRedirectHosts } from '../ingress-routes/traefik-types.js';
import { parseMatchRule, type LiveRoute, TRAEFIK_CRD_PROVIDER } from './traefik-routes.js';

/** One `ingress_routes` row, reduced to what naming needs. */
export interface RouteRow {
  readonly namespace: string;
  readonly hostname: string;
  readonly path: string | null;
  readonly wwwRedirect: string;
  /** Deployment name, or private-worker name; null when neither is set. */
  readonly targetName: string | null;
}

export interface RouteNamingContext {
  /** Traefik service label → the live route that produces it. */
  readonly live: ReadonlyMap<string, LiveRoute>;
  readonly rows: readonly RouteRow[];
  /** Tenant namespace → tenant display name. */
  readonly nsToName: ReadonlyMap<string, string>;
  /** True for a tenant-panel caller: the tenant is implied, so not shown. */
  readonly tenantView: boolean;
}

const ACME_SOLVER_RE = /^(.+)-cm-acme-http-solver-[a-z0-9]+-\d+@kubernetes$/;
const HTTP_OBJECT_RE = /-ingress-http$/;

/** The namespace of a cert-manager HTTP-01 solver service, or null. */
export function acmeSolverNamespace(service: string): string | null {
  return ACME_SOLVER_RE.exec(service)?.[1] ?? null;
}

/**
 * Series the route breakdown leaves out, because they are nobody's route:
 *
 *  • a cert-manager HTTP-01 solver — a certificate being issued, recognisable
 *    by its name alone;
 *  • a route that no longer exists — a CRD-provider label no live rule hashes
 *    to. Its old series lingers in the store for the retention window.
 *
 * The second needs a live index to judge by. When the cluster could not be
 * read (`liveOk` false) nothing is judged missing: dropping a series we
 * merely failed to look up would silently lose real traffic from the view.
 */
export function isHiddenRouteSeries(
  service: string,
  live: ReadonlyMap<string, unknown>,
  liveOk: boolean,
): boolean {
  if (acmeSolverNamespace(service) !== null) return true;
  return liveOk && service.endsWith(`@${TRAEFIK_CRD_PROVIDER}`) && !live.has(service);
}

const rootPath = (p: string | null | undefined): string => (p && p.length > 0 ? p : '/');

/** True when `parent` is `child` or one of its path ancestors. */
function isPathWithin(child: string, parent: string): boolean {
  if (parent === '/' || child === parent) return true;
  return child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

function servesHost(row: RouteRow, host: string): boolean {
  const mode = row.wwwRedirect === 'add-www' || row.wwwRedirect === 'remove-www' ? row.wwwRedirect : 'none';
  const { canonical, alternate } = wwwRedirectHosts(row.hostname, mode);
  return [row.hostname, canonical, alternate].some((h) => h?.toLowerCase() === host);
}

/**
 * The route row serving `host` + `path` in `namespace`: the exact path when
 * there is one, else the nearest ancestor path — a protected directory's
 * child route carries the directory's path but serves its parent's target.
 */
export function findRouteRow(
  rows: readonly RouteRow[], namespace: string, host: string, path: string | null,
): RouteRow | null {
  const want = rootPath(path);
  const lowerHost = host.toLowerCase();
  const candidates = rows
    .filter((r) => r.namespace === namespace && servesHost(r, lowerHost))
    .filter((r) => isPathWithin(want, rootPath(r.path)));
  if (candidates.length === 0) return null;
  return candidates.reduce((best, r) => (rootPath(r.path).length > rootPath(best.path).length ? r : best));
}

function isPlainHttpRouter(route: LiveRoute): boolean {
  if (HTTP_OBJECT_RE.test(route.objectName)) return true;
  return route.entryPoints.length > 0 && route.entryPoints.every((e) => e === 'web');
}

function withTenant(name: string, namespace: string, ctx: RouteNamingContext): string {
  return ctx.tenantView ? name : `${name} · ${ctx.nsToName.get(namespace)}`;
}

function nameLiveRoute(route: LiveRoute, ctx: RouteNamingContext): string | null {
  const rule = parseMatchRule(route.match);
  if (!rule) return null;
  const [host] = rule.hosts;
  const path = rule.path && rule.path !== '/' ? rule.path : '';
  const more = rule.hosts.length > 1 ? ` +${rule.hosts.length - 1}` : '';
  const where = `${host}${path}${more}`;
  if (isPlainHttpRouter(route)) {
    return withTenant(`${where} (http → https redirect)`, route.namespace, ctx);
  }
  const target = findRouteRow(ctx.rows, route.namespace, host, rule.path)?.targetName
    ?? route.backendService;
  return withTenant(target ? `${where} → ${target}` : where, route.namespace, ctx);
}

/** The exact name for a route-scope series, or null to keep the fallback. */
export function exactRouteName(service: string, ctx: RouteNamingContext): string | null {
  const solverNs = acmeSolverNamespace(service);
  if (solverNs) {
    return ctx.nsToName.has(solverNs) ? withTenant('Certificate validation', solverNs, ctx) : null;
  }
  const route = ctx.live.get(service);
  if (!route || !ctx.nsToName.has(route.namespace)) return null;
  return nameLiveRoute(route, ctx);
}

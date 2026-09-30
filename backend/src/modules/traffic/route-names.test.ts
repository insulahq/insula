/**
 * Naming an ingress-route traffic series from the live route it was matched
 * to. Every case here is one the operator approved, stated as the exact
 * string it produces — tenant panel and admin side by side.
 */
import { describe, it, expect } from 'vitest';
import {
  acmeSolverNamespace, exactRouteName, findRouteRow, type RouteRow, isHiddenRouteSeries,
} from './route-names.js';
import { indexLiveRoutes, traefikServiceLabel, type LiveRoute } from './traefik-routes.js';

const NS = 'tenant-example-0a1b2c3d';
const OTHER_NS = 'tenant-beta-ns';
const NESTED_NS = `${NS}-eu-9c0d1e2f`;
const nsToName = new Map([[NS, 'Acme Ltd'], [OTHER_NS, 'Beta Ltd'], [NESTED_NS, 'Acme EU']]);

const route = (over: Partial<LiveRoute> & Pick<LiveRoute, 'match'>): LiveRoute => ({
  namespace: NS,
  objectName: `${NS}-ingress`,
  entryPoints: ['websecure'],
  backendService: 'website',
  ...over,
});
const labelOf = (r: LiveRoute): string => traefikServiceLabel(r.namespace, r.objectName, r.match);

const row = (over: Partial<RouteRow> & Pick<RouteRow, 'hostname'>): RouteRow => ({
  namespace: NS, path: '/', wwwRedirect: 'none', targetName: 'website', ...over,
});

const WWW = route({ match: 'Host(`www.example.test`)' });
const SHOP = route({ match: 'Host(`example.test`) && PathPrefix(`/shop`)', backendService: 'shop' });
const WWW_HTTP = route({ match: 'Host(`www.example.test`)', objectName: `${NS}-ingress-http`, entryPoints: ['web'] });
const WEB_ONLY = route({ match: 'Host(`plain.example.test`)', objectName: `${NS}-ingress-extra`, entryPoints: ['web'] });
// No entryPoints in the spec (Traefik then attaches every entrypoint): only
// the object name says this is the :80 companion.
const HTTP_BY_NAME = route({ match: 'Host(`plain.example.test`)', objectName: `${NS}-ingress-http`, entryPoints: [] });
const BOTH_EPS = route({ match: 'Host(`plain.example.test`)', objectName: `${NS}-ingress-both`, entryPoints: ['web', 'websecure'] });
const NO_ROW = route({ match: 'Host(`api.example.test`)', backendService: 'api-backend' });
const MULTI = route({ match: 'Host(`multi.example.test`) || Host(`www.multi.example.test`)' });
const MULTI_PATH = route({ match: '(Host(`multi.example.test`) || Host(`www.multi.example.test`)) && PathPrefix(`/shop`)', backendService: 'shop' });
const WILDCARD = route({ match: 'HostRegexp(`(?i)^[^.]+\\.sites\\.example\\.test$`)' });
const WORKER = route({ match: 'Host(`tunnel.example.test`)', backendService: 'pw-anchor' });
const CHILD_DIR = route({ match: 'Host(`www.example.test`) && PathPrefix(`/admin`)' });
const WWW_ALT = route({ match: 'Host(`alt.example.test`)' });
const WWW_CANON = route({ match: 'Host(`www.alt.example.test`)' });
const REDIRECT_ONLY = route({ match: 'Host(`old.example.test`)', backendService: 'redirect-sink' });
const OTHER = route({ namespace: OTHER_NS, objectName: `${OTHER_NS}-ingress`, match: 'Host(`beta.example.test`)' });
const NESTED = route({ namespace: NESTED_NS, objectName: `${NESTED_NS}-ingress`, match: 'Host(`eu.example.test`)' });
const PLATFORM = route({ namespace: 'platform', objectName: 'platform-ingress', match: 'Host(`admin.example.test`)', backendService: 'admin-panel' });
const UNREADABLE = route({ match: 'PathPrefix(`/`)' });

const live = indexLiveRoutes([
  WWW, SHOP, WWW_HTTP, WEB_ONLY, HTTP_BY_NAME, BOTH_EPS, NO_ROW, MULTI, MULTI_PATH, WILDCARD, WORKER, CHILD_DIR,
  WWW_ALT, WWW_CANON, REDIRECT_ONLY, OTHER, NESTED, PLATFORM, UNREADABLE,
]);

const rows: RouteRow[] = [
  row({ hostname: 'www.example.test' }),
  row({ hostname: 'example.test', path: '/shop', targetName: 'shop' }),
  row({ hostname: 'plain.example.test' }),
  row({ hostname: 'multi.example.test' }),
  row({ hostname: 'multi.example.test', path: '/shop', targetName: 'shop' }),
  row({ hostname: '*.sites.example.test' }),
  row({ hostname: 'tunnel.example.test', targetName: 'office-nas' }),
  row({ hostname: 'alt.example.test', wwwRedirect: 'add-www' }),
  row({ hostname: 'old.example.test', targetName: null }),
  row({ namespace: OTHER_NS, hostname: 'beta.example.test', targetName: 'blog' }),
  row({ namespace: NESTED_NS, hostname: 'eu.example.test', targetName: 'shop-eu' }),
  // Same hostname in ANOTHER tenant — must never be picked for NS.
  row({ namespace: OTHER_NS, hostname: 'api.example.test', targetName: 'not-yours' }),
];

const tenant = (r: LiveRoute): string | null =>
  exactRouteName(labelOf(r), { live, rows, nsToName, tenantView: true });
const admin = (r: LiveRoute): string | null =>
  exactRouteName(labelOf(r), { live, rows, nsToName, tenantView: false });

describe('exactRouteName — the approved formats', () => {
  it('names a routed host after the deployment behind it', () => {
    expect(tenant(WWW)).toBe('www.example.test → website');
    expect(admin(WWW)).toBe('www.example.test → website · Acme Ltd');
  });

  it('shows a non-root path and omits the root one', () => {
    expect(tenant(SHOP)).toBe('example.test/shop → shop');
    expect(admin(SHOP)).toBe('example.test/shop → shop · Acme Ltd');
  });

  it('names the plain-HTTP router as the redirect it is', () => {
    expect(tenant(WWW_HTTP)).toBe('www.example.test (http → https redirect)');
    expect(admin(WWW_HTTP)).toBe('www.example.test (http → https redirect) · Acme Ltd');
  });

  it('treats a web-only entrypoint as the plain-HTTP router too', () => {
    expect(tenant(WEB_ONLY)).toBe('plain.example.test (http → https redirect)');
  });

  it('recognises the -ingress-http object by name alone', () => {
    expect(tenant(HTTP_BY_NAME)).toBe('plain.example.test (http → https redirect)');
  });

  it('does not call a router serving both entrypoints a redirect', () => {
    expect(tenant(BOTH_EPS)).toBe('plain.example.test → website');
  });

  it('falls back to the backend Service when no route row matches', () => {
    expect(tenant(NO_ROW)).toBe('api.example.test → api-backend');
    expect(admin(NO_ROW)).toBe('api.example.test → api-backend · Acme Ltd');
  });

  it('falls back to the backend Service when the row has no target', () => {
    expect(tenant(REDIRECT_ONLY)).toBe('old.example.test → redirect-sink');
  });

  it('shows the first of several hosts plus a count', () => {
    expect(tenant(MULTI)).toBe('multi.example.test +1 → website');
    expect(admin(MULTI)).toBe('multi.example.test +1 → website · Acme Ltd');
    expect(tenant(MULTI_PATH)).toBe('multi.example.test/shop +1 → shop');
  });

  it('names a wildcard route by its *. hostname', () => {
    expect(tenant(WILDCARD)).toBe('*.sites.example.test → website');
  });

  it('names a private-worker target by the worker', () => {
    expect(tenant(WORKER)).toBe('tunnel.example.test → office-nas');
  });

  it('names a protected-directory child route after its parent route', () => {
    expect(tenant(CHILD_DIR)).toBe('www.example.test/admin → website');
  });

  it('finds the row for both halves of a www redirect', () => {
    expect(tenant(WWW_ALT)).toBe('alt.example.test → website');
    expect(tenant(WWW_CANON)).toBe('www.alt.example.test → website');
  });

  it('uses the tenant the ROUTE lives in, not a namespace prefix', () => {
    expect(admin(OTHER)).toBe('beta.example.test → blog · Beta Ltd');
    // A nested namespace begins with its parent's; the live object says
    // exactly which one it is.
    expect(admin(NESTED)).toBe('eu.example.test → shop-eu · Acme EU');
  });
});

describe('exactRouteName — what it declines to name', () => {
  it('returns null for a label no live route produces', () => {
    const stale = `${NS}-${NS}-ingress-0123456789abcdef0123@kubernetescrd`;
    expect(exactRouteName(stale, { live, rows, nsToName, tenantView: false })).toBeNull();
  });

  it('leaves non-tenant namespaces to the existing names', () => {
    expect(admin(PLATFORM)).toBeNull();
  });

  it('returns null when the rule has no readable host', () => {
    expect(admin(UNREADABLE)).toBeNull();
  });
});

describe('cert-manager ACME solver services', () => {
  const solver = `${NS}-cm-acme-http-solver-x7k2q-8089@kubernetes`;

  it('reads the namespace off the solver service', () => {
    expect(acmeSolverNamespace(solver)).toBe(NS);
    expect(acmeSolverNamespace(`${NESTED_NS}-cm-acme-http-solver-ab1cd-8089@kubernetes`)).toBe(NESTED_NS);
    expect(acmeSolverNamespace(labelOf(WWW))).toBeNull();
  });

  it('is named for what it does', () => {
    expect(exactRouteName(solver, { live, rows, nsToName, tenantView: true })).toBe('Certificate validation');
    expect(exactRouteName(solver, { live, rows, nsToName, tenantView: false })).toBe('Certificate validation · Acme Ltd');
  });

  it('is left alone outside a tenant namespace', () => {
    expect(exactRouteName('platform-cm-acme-http-solver-x7k2q-8089@kubernetes', { live, rows, nsToName, tenantView: false }))
      .toBeNull();
  });
});

describe('findRouteRow', () => {
  it('prefers the exact path over a shorter prefix', () => {
    expect(findRouteRow(rows, NS, 'example.test', '/shop')?.targetName).toBe('shop');
  });

  it('matches hostnames case-insensitively', () => {
    expect(findRouteRow(rows, NS, 'WWW.Example.Test', null)?.targetName).toBe('website');
  });

  it('never crosses into another namespace', () => {
    expect(findRouteRow(rows, NS, 'api.example.test', null)).toBeNull();
  });

  it('does not treat a sibling path as a parent', () => {
    // `/shop` is a string prefix of `/shopping`, but not its parent route.
    expect(findRouteRow([row({ hostname: 'x.example.test', path: '/shop' })], NS, 'x.example.test', '/shopping')).toBeNull();
  });
});

describe('isHiddenRouteSeries', () => {
  const NS = 'tenant-example-0a1b2c3d';
  const liveLabel = `${NS}-${NS}-ingress-69f7b9a673940005ba26@kubernetescrd`;
  const live = new Map([[liveLabel, {}]]);

  it('hides a cert-manager solver whatever the live index says', () => {
    const solver = `${NS}-cm-acme-http-solver-x7k2q-8089@kubernetes`;
    expect(isHiddenRouteSeries(solver, live, true)).toBe(true);
    expect(isHiddenRouteSeries(solver, new Map(), false)).toBe(true);
  });

  it('hides a route label no live rule produces — the route no longer exists', () => {
    expect(isHiddenRouteSeries(`${NS}-${NS}-ingress-0123456789abcdef0123@kubernetescrd`, live, true)).toBe(true);
    expect(isHiddenRouteSeries(liveLabel, live, true)).toBe(false);
  });

  it('judges nothing missing when the cluster could not be read', () => {
    expect(isHiddenRouteSeries(`${NS}-${NS}-ingress-0123456789abcdef0123@kubernetescrd`, new Map(), false)).toBe(false);
  });

  it('leaves labels of other providers alone — the index cannot vouch for them', () => {
    expect(isHiddenRouteSeries('api@internal', live, true)).toBe(false);
    expect(isHiddenRouteSeries('platform-legacy-ingress-80@kubernetes', live, true)).toBe(false);
  });
});

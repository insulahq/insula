/**
 * The routers and Middlewares a route with OIDC sign-in renders: the gate's
 * ForwardAuth, the `/oauth2` router to oauth2-proxy, and protected folders —
 * all on the host the route SERVES (a www redirect's canonical form).
 */
import { describe, it, expect } from 'vitest';
import { buildRouteSpec } from './annotation-sync.js';

const ROUTE_ID = 'abcdef01-0000-4000-8000-000000000001';
const NS = 'tenant-a';

type Rows = Record<string, unknown[]>;

/** Drizzle stand-in: every query on a table resolves to that table's rows. */
function fakeDb(rows: Rows) {
  const chain = (table: string): unknown => {
    const result = rows[table] ?? [];
    const c: Record<string, unknown> = {
      then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => Promise.resolve(result).then(ok, err),
    };
    for (const m of ['where', 'innerJoin', 'leftJoin', 'limit', 'orderBy']) c[m] = () => c;
    return c;
  };
  return {
    select: () => ({ from: (t: Record<symbol, string>) => chain(t[Symbol.for('drizzle:Name')]!) }),
  } as never;
}

const k8s = {
  core: new Proxy({}, { get: () => async () => ({}) }),
  custom: new Proxy({}, { get: () => async () => ({ items: [] }) }),
} as never;

function route(over: Record<string, unknown> = {}) {
  return {
    id: ROUTE_ID, hostname: 'example.test', wwwRedirect: 'add-www', path: null, forceHttps: 0, redirectUrl: null,
    ipAllowlist: null, rateLimitRps: null, rateLimitConnections: null, rateLimitBurstMultiplier: null, wafEnabled: 0,
    wafOwaspCrs: 0, wafAnomalyThreshold: 10, wafExcludedRules: null, customErrorCodes: null, customErrorPath: null,
    additionalHeaders: null, status: 'active', ...over,
  };
}

function rowsFor(opts: { oidc?: Record<string, unknown> | null; folder?: boolean; route?: Record<string, unknown> } = {}): Rows {
  return {
    ingress_routes: [route(opts.route)],
    tenants: [{ id: 't-1', kubernetesNamespace: NS, bandwidthCapped: false }],
    ingress_auth_configs: opts.oidc === null ? [] : [{ ingressRouteId: ROUTE_ID, enabled: true, passAuthorizationHeader: false, ...opts.oidc }],
    route_protected_dirs: opts.folder ? [{ id: 'dir00001-0000', routeId: ROUTE_ID, path: '/private', realm: 'R', enabled: 1 }] : [],
    route_auth_users: opts.folder ? [{ id: 'u1', dirId: 'dir00001-0000', username: 'a', passwordHash: '$apr1$x', enabled: 1 }] : [],
  };
}

const build = (rows: Rows) => buildRouteSpec(fakeDb(rows), k8s, ROUTE_ID, 't-1', 'app', 80);

describe('a route with OIDC sign-in', () => {
  it('★ asks the gate sidecar about THIS route, and lists every identity header but Authorization', async () => {
    const spec = (await build(rowsFor({})))!;
    const mw = spec.middlewares.find((m) => m.metadata.name === 'r-abcdef01-oidc')!;
    const fa = (mw.spec as { forwardAuth: { address: string; authResponseHeaders: string[]; trustForwardHeader: boolean } }).forwardAuth;
    expect(fa.address).toBe(`http://oauth2-proxy.${NS}.svc.cluster.local:4181/auth?route=${ROUTE_ID}`);
    expect(fa.trustForwardHeader).toBe(false);
    expect(fa.authResponseHeaders).toEqual(expect.arrayContaining(['X-Auth-Request-Email', 'X-Auth-Request-Id-Token', 'X-Auth-Request-Access-Token']));
    // Listing Authorization would delete the visitor's own (an API token).
    expect(fa.authResponseHeaders).not.toContain('Authorization');
    // A session refreshed on this request reaches the browser.
    expect((mw.spec as { forwardAuth: { addAuthCookiesToResponse: string[] } }).forwardAuth.addAuthCookiesToResponse).toContain('_insula_gate');
    expect(spec.middlewareRefs.map((r) => r.name)).toContain('r-abcdef01-oidc');
  });

  it('★ serves /oauth2 on the served host, straight to oauth2-proxy, past the gate', async () => {
    const spec = (await build(rowsFor({})))!;
    const signIn = spec.childRoutes.find((r) => r.match.includes('/oauth2'))!;
    expect(signIn.match).toContain('www.example.test');
    expect(signIn.match).toContain('/oauth2/');
    expect(signIn.priority).toBe(10_000);
    expect(signIn.services).toEqual([{ name: 'oauth2-proxy', port: 4180 }]);
    const names = (signIn.middlewares ?? []).map((m) => m.name);
    expect(names).not.toContain('r-abcdef01-oidc');
    expect(names).toContain('crowdsec');
  });

  it('★ protected folders are matched on the served host, not the one that only redirects', async () => {
    const spec = (await build(rowsFor({ oidc: null, folder: true })))!;
    const folder = spec.childRoutes.find((r) => r.match.includes('/private'))!;
    expect(folder.match).toContain('www.example.test');
    expect(folder.match).not.toMatch(/`example\.test`/);
  });

  it('folders get a gate that leaves Authorization (their Basic credentials) alone', async () => {
    const spec = (await build(rowsFor({ oidc: { passAuthorizationHeader: true }, folder: true })))!;
    const main = spec.middlewares.find((m) => m.metadata.name === 'r-abcdef01-oidc')!;
    expect((main.spec as { forwardAuth: { authResponseHeaders: string[] } }).forwardAuth.authResponseHeaders).toContain('Authorization');
    const dirsGate = spec.middlewares.find((m) => m.metadata.name === 'r-abcdef01-oidc-dirs')!;
    expect((dirsGate.spec as { forwardAuth: { authResponseHeaders: string[] } }).forwardAuth.authResponseHeaders).not.toContain('Authorization');
    const folder = spec.childRoutes.find((r) => r.match.includes('/private'))!;
    const names = (folder.middlewares ?? []).map((m) => m.name);
    expect(names).toContain('r-abcdef01-oidc-dirs');
    expect(names).not.toContain('r-abcdef01-oidc');
  });

  it('nothing of the gate when sign-in is off', async () => {
    const spec = (await build(rowsFor({ oidc: { enabled: false } })))!;
    expect(spec.middlewares.some((m) => m.metadata.name.includes('-oidc'))).toBe(false);
    expect(spec.childRoutes.some((r) => r.match.includes('/oauth2'))).toBe(false);
  });
});

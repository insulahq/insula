/**
 * Force-HTTPS HTTP-entrypoint route builder.
 *
 * Background: prior to this change, every tenant IngressRoute was emitted
 * on the `websecure` (HTTPS) entrypoint only. The `force-https` Middleware
 * was being emitted by annotation-sync (a redirectScheme spec) but no
 * route on the `web` (HTTP) entrypoint ever referenced it, so the
 * customer-visible toggle was a no-op (annotation-sync.ts:226-231 explicitly
 * documented this gap). HTTP requests to a forceHttps=true route returned
 * a Traefik default 404 instead of a 301 redirect.
 *
 * Fix: a parallel `web`-entrypoint IngressRoute is emitted when ANY route
 * in the tenant set has forceHttps=true. The parallel route matches the
 * same hostname (and path if set) and attaches ONLY the force-https
 * Middleware — the middleware returns 301 before any other middleware in
 * the chain runs, so IP allowlist / rate limit / auth never evaluate on
 * the redirected HTTP request.
 *
 * Tests cover the pure builder (`buildForceHttpsRoutes`); the wider
 * reconcileIngress integration (apply, GC) is exercised by the live
 * Phase L harness on staging.
 */

import { describe, expect, it } from 'vitest';
import { buildForceHttpsRoutes } from './k8s-ingress.js';

const baseRoute = {
  id: '00000000-0000-0000-0000-000000000001',
  hostname: 'app.example.com',
  path: '/' as string,
  forceHttps: 0,
  wwwRedirect: 'none' as 'none' | 'add-www' | 'remove-www',
};

const resolveBackend = (_routeId: string): { serviceName: string; port: number } | null => ({
  serviceName: 'app-svc',
  port: 8080,
});

describe('buildForceHttpsRoutes', () => {
  it('returns [] when no route has forceHttps=true (no HTTP IngressRoute needed)', () => {
    const routes = [
      { ...baseRoute, id: 'r-1', forceHttps: 0 },
      { ...baseRoute, id: 'r-2', hostname: 'b.example.com', forceHttps: 0 },
    ];
    expect(buildForceHttpsRoutes(routes, resolveBackend, 'ns-x')).toEqual([]);
  });

  it('emits one HTTP TraefikRoute per forceHttps=true route, attaching the force-https Middleware', () => {
    const routes = [
      { ...baseRoute, id: 'aaaaaaaa-1111-1111-1111-111111111111', hostname: 'a.example.com', forceHttps: 1 },
      { ...baseRoute, id: 'bbbbbbbb-2222-2222-2222-222222222222', hostname: 'b.example.com', forceHttps: 0 },
      { ...baseRoute, id: 'cccccccc-3333-3333-3333-333333333333', hostname: 'c.example.com', forceHttps: 1 },
    ];
    const out = buildForceHttpsRoutes(routes, resolveBackend, 'ns-x');
    expect(out).toHaveLength(2);
    // The Middleware name is derived deterministically from the route id
    // (8-char prefix) + '-force-https' suffix, mirroring annotation-sync.
    expect(out[0].middlewares).toEqual([
      { name: 'r-aaaaaaaa-force-https', namespace: 'ns-x' },
    ]);
    expect(out[1].middlewares).toEqual([
      { name: 'r-cccccccc-force-https', namespace: 'ns-x' },
    ]);
    // Only the forceHttps=1 hostnames make it in.
    expect(out.map((r) => r.match)).toEqual([
      'Host(`a.example.com`)',
      'Host(`c.example.com`)',
    ]);
  });

  it('honours route.path when set (so /api routes match only /api on HTTP too)', () => {
    const routes = [
      { ...baseRoute, id: 'dddddddd-4444-4444-4444-444444444444', hostname: 'api.example.com', path: '/api', forceHttps: 1 },
    ];
    const out = buildForceHttpsRoutes(routes, resolveBackend, 'ns-x');
    expect(out).toHaveLength(1);
    expect(out[0].match).toBe('Host(`api.example.com`) && PathPrefix(`/api`)');
  });

  it('uses the canonical (post-www-redirect) hostname so the HTTP route matches the same host the HTTPS route advertises', () => {
    const routes = [
      // add-www: HTTPS route matches www.example.com → the HTTP route
      // MUST also match www.example.com (not example.com) so the
      // operator's force-https toggle works on the same canonical host.
      { ...baseRoute, id: 'eeeeeeee-5555-5555-5555-555555555555', hostname: 'example.com', wwwRedirect: 'add-www', forceHttps: 1 },
    ];
    const out = buildForceHttpsRoutes(routes, resolveBackend, 'ns-x');
    expect(out).toHaveLength(1);
    expect(out[0].match).toBe('Host(`www.example.com`)');
  });

  it('omits routes whose backend cannot be resolved (suspended/orphaned routes)', () => {
    const routes = [
      { ...baseRoute, id: 'ffffffff-6666-6666-6666-666666666666', hostname: 'orphan.example.com', forceHttps: 1 },
    ];
    const out = buildForceHttpsRoutes(routes, (_id) => null, 'ns-x');
    // No HTTP route emitted — without a backend we can't construct the
    // services[] field, and an IngressRoute without services is rejected
    // by Traefik's CRD validation. The HTTPS route is similarly skipped
    // in reconcileIngress (line ~352), so the symmetry holds.
    expect(out).toEqual([]);
  });

  it('points services[] at the same backend the HTTPS route uses (the redirect fires before traffic reaches it, but services is a required field on TraefikRoute)', () => {
    const routes = [
      { ...baseRoute, id: 'aaaa1111-aaaa-1111-aaaa-111111111111', hostname: 'a.example.com', forceHttps: 1 },
    ];
    const out = buildForceHttpsRoutes(routes, () => ({ serviceName: 'app-svc', port: 8080 }), 'ns-x');
    // Lock services[].length=1 so a future bug that appends additional
    // entries (e.g. accidental fan-out across components) is caught by
    // this test — Traefik would happily round-robin between them, but
    // the redirect semantics are single-target by design.
    expect(out[0].services).toHaveLength(1);
    expect(out[0].services).toEqual([{ name: 'app-svc', port: 8080 }]);
  });
});

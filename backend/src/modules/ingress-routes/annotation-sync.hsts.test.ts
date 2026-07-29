import { describe, it, expect } from 'vitest';
import { buildMiddlewaresForRoute, type RouteSettingsLike } from './annotation-sync.js';

const baseRoute: RouteSettingsLike = {
  forceHttps: 0,
  wwwRedirect: 'none',
  redirectUrl: null,
  ipAllowlist: null,
  rateLimitRps: null,
  rateLimitConnections: null,
  rateLimitBurstMultiplier: null,
  wafEnabled: 0,
  wafOwaspCrs: 0,
  wafAnomalyThreshold: 10,
  wafExcludedRules: null,
  customErrorCodes: null,
  customErrorPath: null,
};

const ROUTE_ID = 'route-12345678';
const NS = 'tenant-ns';

function hstsOf(route: RouteSettingsLike) {
  const { middlewares, referenceList } = buildMiddlewaresForRoute(route, ROUTE_ID, NS);
  const mw = middlewares.find((m) => m.metadata.labels?.['hosting-platform/middleware-kind'] === 'hsts');
  return { mw, middlewares, referenceList };
}

describe('buildMiddlewaresForRoute — HSTS', () => {
  it('emits NO HSTS Middleware when hstsEnabled is unset', () => {
    const { mw, referenceList } = hstsOf(baseRoute);
    expect(mw).toBeUndefined();
    expect(referenceList.find((r) => r.name.endsWith('-hsts'))).toBeUndefined();
  });

  it('emits NO HSTS Middleware when hstsEnabled=0', () => {
    const { mw } = hstsOf({ ...baseRoute, hstsEnabled: 0, hstsMaxAge: 31536000 });
    expect(mw).toBeUndefined();
  });

  it('emits stsSeconds when enabled, and references it', () => {
    const { mw, referenceList } = hstsOf({ ...baseRoute, hstsEnabled: 1, hstsMaxAge: 31536000 });
    expect(mw).toBeDefined();
    expect(mw!.spec).toEqual({ headers: { stsSeconds: 31536000 } });
    expect(referenceList.some((r) => r.name === mw!.metadata.name && r.namespace === NS)).toBe(true);
  });

  it('never sets forceSTSHeader — the header must not appear on plain HTTP', () => {
    const { mw } = hstsOf({
      ...baseRoute,
      hstsEnabled: 1,
      hstsMaxAge: 31536000,
      hstsIncludeSubdomains: 1,
      hstsPreload: 1,
    });
    const headers = (mw!.spec as { headers: Record<string, unknown> }).headers;
    expect(headers).not.toHaveProperty('forceSTSHeader');
  });

  it('carries includeSubDomains and preload when set', () => {
    const { mw } = hstsOf({
      ...baseRoute,
      hstsEnabled: 1,
      hstsMaxAge: 31536000,
      hstsIncludeSubdomains: 1,
      hstsPreload: 1,
    });
    expect(mw!.spec).toEqual({
      headers: { stsSeconds: 31536000, stsIncludeSubdomains: true, stsPreload: true },
    });
  });

  it('omits the sub-flags when they are 0 rather than emitting false', () => {
    const { mw } = hstsOf({
      ...baseRoute,
      hstsEnabled: 1,
      hstsMaxAge: 600,
      hstsIncludeSubdomains: 0,
      hstsPreload: 0,
    });
    expect(mw!.spec).toEqual({ headers: { stsSeconds: 600 } });
  });

  it('emits stsSeconds: 0 verbatim — max-age=0 is how a policy is revoked', () => {
    const { mw } = hstsOf({ ...baseRoute, hstsEnabled: 1, hstsMaxAge: 0 });
    expect(mw).toBeDefined();
    const headers = (mw!.spec as { headers: Record<string, unknown> }).headers;
    expect(headers.stsSeconds).toBe(0);
  });

  it('defaults max-age to 1 year when the column is missing', () => {
    const { mw } = hstsOf({ ...baseRoute, hstsEnabled: 1 });
    const headers = (mw!.spec as { headers: Record<string, unknown> }).headers;
    expect(headers.stsSeconds).toBe(31536000);
  });

  it('is ordered before short-circuiting middlewares so blocked responses keep the header', () => {
    // ip-allow (403), rate-limit (429) and redirect (301) all return without
    // reaching the backend. Traefik unwinds the chain in reverse on the way
    // out, so HSTS must sit to their LEFT for those responses to carry it.
    const { referenceList } = hstsOf({
      ...baseRoute,
      hstsEnabled: 1,
      hstsMaxAge: 31536000,
      ipAllowlist: '10.0.0.0/8',
      rateLimitRps: 10,
      redirectUrl: 'https://example.test/',
    });
    const names = referenceList.map((r) => r.name);
    const idx = (suffix: string) => names.findIndex((n) => n.endsWith(suffix));

    expect(idx('-hsts')).toBeGreaterThanOrEqual(0);
    expect(idx('-hsts')).toBeLessThan(idx('-ipallow'));
    expect(idx('-hsts')).toBeLessThan(idx('-ratelimit'));
    expect(idx('-hsts')).toBeLessThan(idx('-redirect'));
  });

  it('does not disturb the other middlewares', () => {
    const withHsts = buildMiddlewaresForRoute(
      { ...baseRoute, hstsEnabled: 1, hstsMaxAge: 31536000, ipAllowlist: '10.0.0.0/8' },
      ROUTE_ID,
      NS,
    );
    const withoutHsts = buildMiddlewaresForRoute(
      { ...baseRoute, ipAllowlist: '10.0.0.0/8' },
      ROUTE_ID,
      NS,
    );
    expect(withHsts.middlewares.length).toBe(withoutHsts.middlewares.length + 1);
    const ipAllow = withHsts.middlewares.find((m) => m.metadata.name.endsWith('-ipallow'));
    expect(ipAllow).toEqual(withoutHsts.middlewares.find((m) => m.metadata.name.endsWith('-ipallow')));
  });
});

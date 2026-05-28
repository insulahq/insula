/**
 * Characterization tests for the per-route Middleware emitters that
 * `buildMiddlewaresForRoute` produces. Pairs with annotation-sync.waf.test.ts
 * (which covers WAF + connections + error pages); this file covers the
 * remaining 7 emitters identified in the 2026-05-28 route-config audit:
 *
 *   - forceHttps          → redirectScheme Middleware
 *   - wwwRedirect         → redirectRegex Middleware (add-www / remove-www)
 *   - ipAllowlist         → ipAllowList Middleware
 *   - rateLimitRps        → rateLimit Middleware (with burst-multiplier math)
 *   - additionalHeaders   → headers Middleware (with sanitisation)
 *   - customRedirectUrl   → redirectRegex Middleware (catch-all .*)
 *   - middleware ordering — settings refs come out in the documented order
 *
 * Notes:
 *   - OIDC, mTLS, and protected-dirs are NOT covered here because they're
 *     emitted by separate helpers (buildOidcMiddleware,
 *     syncMtlsSecretAndBuildSpec, buildProtectedDirChildRoutes) that pull
 *     from their own DB tables and require a richer test harness. They're
 *     verified end-to-end by integration-oidc-dex.sh +
 *     integration-mtls-e2e.sh + the new Phase L harness.
 */

import { describe, expect, it } from 'vitest';
import { buildMiddlewaresForRoute, type RouteSettingsLike } from './annotation-sync.js';
import type { MiddlewareBody } from './traefik-types.js';

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

const ROUTE_ID = '01020304-0506-0708-090a-0b0c0d0e0f10';
const NS = 'tenant-test-ns';

const findMw = (mws: MiddlewareBody[], suffix: string): MiddlewareBody | undefined =>
  mws.find((m) => m.metadata.name.endsWith(`-${suffix}`));

// ─── Force HTTPS ────────────────────────────────────────────────────────

describe('buildMiddlewaresForRoute — forceHttps', () => {
  it('emits a redirectScheme Middleware + ref when forceHttps=1', () => {
    const { middlewares, referenceList } = buildMiddlewaresForRoute(
      { ...baseRoute, forceHttps: 1 },
      ROUTE_ID,
      NS,
    );
    const mw = findMw(middlewares, 'force-https');
    expect(mw).toBeDefined();
    expect(mw?.spec).toMatchObject({
      redirectScheme: { scheme: 'https', permanent: true },
    });
    expect(referenceList).toContainEqual({ name: `r-${ROUTE_ID.slice(0, 8)}-force-https`, namespace: NS });
  });

  it('emits NO force-https Middleware when forceHttps=0', () => {
    const { middlewares, referenceList } = buildMiddlewaresForRoute(baseRoute, ROUTE_ID, NS);
    expect(findMw(middlewares, 'force-https')).toBeUndefined();
    expect(referenceList.find((r) => r.name.endsWith('-force-https'))).toBeUndefined();
  });
});

// ─── www redirect ───────────────────────────────────────────────────────

describe('buildMiddlewaresForRoute — wwwRedirect', () => {
  it('emits an add-www redirectRegex when wwwRedirect="add-www"', () => {
    const { middlewares, referenceList } = buildMiddlewaresForRoute(
      { ...baseRoute, wwwRedirect: 'add-www' },
      ROUTE_ID,
      NS,
    );
    const mw = findMw(middlewares, 'wwwredir');
    const spec = mw?.spec as { redirectRegex?: { regex: string; replacement: string; permanent: boolean } };
    // The regex is the PCRE that matches non-www and www variants both;
    // the replacement injects www. into the canonical form.
    expect(spec?.redirectRegex?.regex).toMatch(/^\^https\?:\/\//);
    expect(spec?.redirectRegex?.replacement).toContain('www.');
    expect(spec?.redirectRegex?.permanent).toBe(true);
    expect(referenceList).toContainEqual({ name: `r-${ROUTE_ID.slice(0, 8)}-wwwredir`, namespace: NS });
  });

  it('emits a remove-www redirectRegex when wwwRedirect="remove-www" — replacement strips www', () => {
    const { middlewares } = buildMiddlewaresForRoute(
      { ...baseRoute, wwwRedirect: 'remove-www' },
      ROUTE_ID,
      NS,
    );
    const mw = findMw(middlewares, 'wwwredir');
    const spec = mw?.spec as { redirectRegex?: { regex: string; replacement: string } };
    expect(spec?.redirectRegex?.regex).toContain('www\\.');
    // The replacement is the bare host (no www. prefix).
    expect(spec?.redirectRegex?.replacement).not.toContain('www.');
  });

  it('emits NO wwwredir Middleware when wwwRedirect="none"', () => {
    const { middlewares } = buildMiddlewaresForRoute(baseRoute, ROUTE_ID, NS);
    expect(findMw(middlewares, 'wwwredir')).toBeUndefined();
  });
});

// ─── IP allowlist ───────────────────────────────────────────────────────

describe('buildMiddlewaresForRoute — ipAllowlist', () => {
  it('emits an ipAllowList Middleware with the parsed CIDRs', () => {
    const { middlewares, referenceList } = buildMiddlewaresForRoute(
      { ...baseRoute, ipAllowlist: '10.0.0.0/8, 192.168.1.0/24' },
      ROUTE_ID,
      NS,
    );
    const mw = findMw(middlewares, 'ipallow');
    expect(mw).toBeDefined();
    const spec = mw?.spec as { ipAllowList?: { sourceRange: string[] } };
    expect(spec?.ipAllowList?.sourceRange).toEqual(['10.0.0.0/8', '192.168.1.0/24']);
    expect(referenceList.find((r) => r.name.endsWith('-ipallow'))).toBeDefined();
  });

  it('trims whitespace around CIDRs (operators paste with stray spaces all the time)', () => {
    const { middlewares } = buildMiddlewaresForRoute(
      { ...baseRoute, ipAllowlist: '  10.0.0.0/8 ,192.168.1.0/24 ' },
      ROUTE_ID,
      NS,
    );
    const mw = findMw(middlewares, 'ipallow');
    const spec = mw?.spec as { ipAllowList?: { sourceRange: string[] } };
    expect(spec?.ipAllowList?.sourceRange).toEqual(['10.0.0.0/8', '192.168.1.0/24']);
  });

  it('emits NO ipallow Middleware when ipAllowlist is null', () => {
    const { middlewares } = buildMiddlewaresForRoute(baseRoute, ROUTE_ID, NS);
    expect(findMw(middlewares, 'ipallow')).toBeUndefined();
  });

  it('emits NO ipallow Middleware when ipAllowlist is empty/whitespace only', () => {
    const { middlewares } = buildMiddlewaresForRoute(
      { ...baseRoute, ipAllowlist: '   ,  ,   ' },
      ROUTE_ID,
      NS,
    );
    // After splitting + trimming + filtering empty, no CIDRs remain → no Middleware.
    expect(findMw(middlewares, 'ipallow')).toBeUndefined();
  });
});

// ─── rateLimitRps ───────────────────────────────────────────────────────

describe('buildMiddlewaresForRoute — rateLimitRps', () => {
  it('emits a rateLimit Middleware with default burst multiplier of 5', () => {
    const { middlewares, referenceList } = buildMiddlewaresForRoute(
      { ...baseRoute, rateLimitRps: 10 },
      ROUTE_ID,
      NS,
    );
    const mw = findMw(middlewares, 'ratelimit');
    expect(mw?.spec).toMatchObject({
      rateLimit: { average: 10, burst: 50 }, // 10 * 5 default multiplier
    });
    expect(referenceList.find((r) => r.name.endsWith('-ratelimit'))).toBeDefined();
  });

  it('honours custom rateLimitBurstMultiplier (passed as string from Decimal column)', () => {
    const { middlewares } = buildMiddlewaresForRoute(
      { ...baseRoute, rateLimitRps: 10, rateLimitBurstMultiplier: '3' },
      ROUTE_ID,
      NS,
    );
    const mw = findMw(middlewares, 'ratelimit');
    expect(mw?.spec).toMatchObject({ rateLimit: { average: 10, burst: 30 } });
  });

  it('rounds fractional burst up to at least 1 (so 0.5 rps × 1 = 1, never 0)', () => {
    const { middlewares } = buildMiddlewaresForRoute(
      { ...baseRoute, rateLimitRps: 1, rateLimitBurstMultiplier: '0.4' },
      ROUTE_ID,
      NS,
    );
    const mw = findMw(middlewares, 'ratelimit');
    const spec = mw?.spec as { rateLimit?: { burst: number } };
    // Math.round(1 * 0.4) = 0 → Math.max(1, 0) = 1.
    expect(spec?.rateLimit?.burst).toBe(1);
  });

  it('emits NO rateLimit Middleware when rateLimitRps is null', () => {
    const { middlewares } = buildMiddlewaresForRoute(baseRoute, ROUTE_ID, NS);
    expect(findMw(middlewares, 'ratelimit')).toBeUndefined();
  });
});

// ─── additionalHeaders ─────────────────────────────────────────────────

describe('buildMiddlewaresForRoute — additionalHeaders', () => {
  it('emits a headers Middleware with the customResponseHeaders map', () => {
    const { middlewares, referenceList } = buildMiddlewaresForRoute(
      {
        ...baseRoute,
        additionalHeaders: {
          'X-Frame-Options': 'DENY',
          'X-Content-Type-Options': 'nosniff',
        },
      },
      ROUTE_ID,
      NS,
    );
    const mw = findMw(middlewares, 'headers');
    expect(mw?.spec).toMatchObject({
      headers: {
        customResponseHeaders: {
          'X-Frame-Options': 'DENY',
          'X-Content-Type-Options': 'nosniff',
        },
      },
    });
    expect(referenceList.find((r) => r.name.endsWith('-headers'))).toBeDefined();
  });

  it('emits NO headers Middleware when additionalHeaders is null', () => {
    const { middlewares } = buildMiddlewaresForRoute(baseRoute, ROUTE_ID, NS);
    expect(findMw(middlewares, 'headers')).toBeUndefined();
  });

  it('emits NO headers Middleware when additionalHeaders is an empty object', () => {
    // sanitiseHeaderMap returns null for empty input → no Middleware emitted.
    const { middlewares } = buildMiddlewaresForRoute(
      { ...baseRoute, additionalHeaders: {} },
      ROUTE_ID,
      NS,
    );
    expect(findMw(middlewares, 'headers')).toBeUndefined();
  });
});

// ─── customRedirectUrl ─────────────────────────────────────────────────

describe('buildMiddlewaresForRoute — customRedirectUrl', () => {
  it('emits a redirectRegex Middleware with regex=".*" so every path is redirected', () => {
    const { middlewares, referenceList } = buildMiddlewaresForRoute(
      { ...baseRoute, redirectUrl: 'https://newsite.example.com' },
      ROUTE_ID,
      NS,
    );
    const mw = findMw(middlewares, 'redirect');
    expect(mw?.spec).toMatchObject({
      redirectRegex: {
        regex: '.*',
        replacement: 'https://newsite.example.com',
        permanent: true,
      },
    });
    expect(referenceList.find((r) => r.name.endsWith('-redirect'))).toBeDefined();
  });

  it('emits NO redirect Middleware when redirectUrl is null', () => {
    const { middlewares } = buildMiddlewaresForRoute(baseRoute, ROUTE_ID, NS);
    expect(findMw(middlewares, 'redirect')).toBeUndefined();
  });
});

// ─── Reference ordering ────────────────────────────────────────────────

describe('buildMiddlewaresForRoute — reference ordering', () => {
  it('emits settings middlewares in the implementation order (forceHttps → ipallow → rateLimit → inflight → headers → redirect → WAF → errors → wwwredir)', () => {
    // Order matches the source-code sequence in
    // annotation-sync.ts:buildMiddlewaresForRoute, which is the order
    // they execute in Traefik's middleware chain. WAF runs BEFORE the
    // custom-errors backend so a CRS-blocked request is rendered via
    // the tenant-errors backend (the operator's branded 403/500 page)
    // instead of Traefik's default response.
    const { referenceList } = buildMiddlewaresForRoute(
      {
        ...baseRoute,
        forceHttps: 1,
        ipAllowlist: '10.0.0.0/8',
        rateLimitRps: 10,
        rateLimitConnections: 5,
        additionalHeaders: { 'X-Frame-Options': 'DENY' },
        redirectUrl: 'https://new.example.com',
        wafEnabled: 1,
        customErrorCodes: '404',
        customErrorPath: '/errors/404.html',
        wwwRedirect: 'add-www',
      },
      ROUTE_ID,
      NS,
    );
    // Map names to their suffix for assertion readability.
    const suffixes = referenceList.map((r) => {
      // WAF ref is the shared sidecar — name is fully qualified.
      if (r.name === 'modsecurity-crs') return 'modsecurity-crs';
      // Per-route names use r-<routeId-prefix>-<suffix>.
      const m = r.name.match(/^r-[0-9a-f]{8}-(.+)$/);
      return m ? m[1] : r.name;
    });
    expect(suffixes).toEqual([
      'force-https',
      'ipallow',
      'ratelimit',
      'inflight',
      'headers',
      'redirect',
      'modsecurity-crs',
      'errors',
      'wwwredir',
    ]);
  });
});

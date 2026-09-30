/**
 * Traefik's per-route service label, computed FORWARD from a live
 * IngressRoute — and the match rules the platform emits, read back into a
 * host and a path.
 *
 * The hash is a one-way function of the literal match string, so the only way
 * to name a `traefik_service_*` series exactly is to hash every live rule and
 * look the label up. A one-character difference in the rule (a space, a
 * rebuilt-from-the-database approximation) yields a different hash that
 * silently matches nothing, which is why the vectors below are exact.
 */
import { describe, it, expect } from 'vitest';
import {
  indexLiveRoutes, liveRoutesFromList, normalizeTraefikName, parseMatchRule,
  traefikRuleHash, traefikServiceLabel,
} from './traefik-routes.js';
import { hostMatch, routeMatch } from '../ingress-routes/traefik-types.js';

const NS = 'tenant-example-0a1b2c3d';

describe('traefikRuleHash', () => {
  it('is the first 20 hex of sha256 over the literal rule', () => {
    // Independently computed: printf '%s' 'Host(`www.example.test`)' | sha256sum
    expect(traefikRuleHash('Host(`www.example.test`)')).toBe('69f7b9a673940005ba26');
    expect(traefikRuleHash('Host(`example.test`) && PathPrefix(`/shop`)')).toBe('147c899de9b819b12821');
    expect(traefikRuleHash('HostRegexp(`(?i)^[^.]+\\.example\\.test$`)')).toBe('1675556d09ef5c24c800');
  });

  it('changes with a single character of the rule', () => {
    expect(traefikRuleHash('Host(`www.example.test`) ')).not.toBe('69f7b9a673940005ba26');
  });
});

describe('traefikServiceLabel', () => {
  it('is <namespace>-<object>-<hash>@kubernetescrd', () => {
    expect(traefikServiceLabel(NS, `${NS}-ingress`, 'Host(`www.example.test`)'))
      .toBe(`${NS}-${NS}-ingress-69f7b9a673940005ba26@kubernetescrd`);
  });

  it('gives the http-entrypoint object a different label for the same rule', () => {
    const https = traefikServiceLabel(NS, `${NS}-ingress`, 'Host(`www.example.test`)');
    const http = traefikServiceLabel(NS, `${NS}-ingress-http`, 'Host(`www.example.test`)');
    expect(http).toBe(`${NS}-${NS}-ingress-http-69f7b9a673940005ba26@kubernetescrd`);
    expect(http).not.toBe(https);
  });

  it('normalises the way Traefik does — every non-alphanumeric run becomes one hyphen', () => {
    expect(normalizeTraefikName('platform-web.admin--ingress')).toBe('platform-web-admin-ingress');
    expect(normalizeTraefikName('-a..b-')).toBe('a-b');
    expect(traefikServiceLabel('platform', 'web.admin', 'Host(`admin.example.test`)'))
      .toMatch(/^platform-web-admin-[0-9a-f]{20}@kubernetescrd$/);
  });
});

describe('parseMatchRule — every shape the platform emits', () => {
  it('reads a bare Host()', () => {
    expect(parseMatchRule('Host(`www.example.test`)')).toEqual({ hosts: ['www.example.test'], path: null, label: null });
  });

  it('reads Host() narrowed by PathPrefix()', () => {
    expect(parseMatchRule('Host(`example.test`) && PathPrefix(`/shop`)'))
      .toEqual({ hosts: ['example.test'], path: '/shop', label: '/shop' });
  });

  it('reads the wildcard HostRegexp() back into its *. hostname', () => {
    expect(parseMatchRule('HostRegexp(`(?i)^[^.]+\\.example\\.test$`)'))
      .toEqual({ hosts: ['*.example.test'], path: null, label: null });
    expect(parseMatchRule('HostRegexp(`(?i)^[^.]+\\.sites\\.example\\.test$`) && PathPrefix(`/api`)'))
      .toEqual({ hosts: ['*.sites.example.test'], path: '/api', label: '/api' });
  });

  it('reads ||-joined hosts in order, with or without parentheses', () => {
    expect(parseMatchRule('Host(`example.test`) || Host(`www.example.test`)'))
      .toEqual({ hosts: ['example.test', 'www.example.test'], path: null, label: null });
    expect(parseMatchRule('(Host(`a.example.test`) || Host(`b.example.test`)) && PathPrefix(`/x`)'))
      .toEqual({ hosts: ['a.example.test', 'b.example.test'], path: '/x', label: '/x' });
  });

  it('reads the multi-argument Host() form', () => {
    expect(parseMatchRule('Host(`a.example.test`, `b.example.test`)'))
      .toEqual({ hosts: ['a.example.test', 'b.example.test'], path: null, label: null });
  });

  it('reads an exact Path() as the path', () => {
    expect(parseMatchRule('Host(`example.test`) && Path(`/health`)'))
      .toEqual({ hosts: ['example.test'], path: '/health', label: '/health' });
  });

  it('lists a repeated host once', () => {
    expect(parseMatchRule('Host(`example.test`) || Host(`example.test`)')?.hosts).toEqual(['example.test']);
  });

  it('round-trips whatever the platform’s own rule builders emit', () => {
    // Pinned to the builders rather than to hand-written strings, so a change
    // to how rules are composed fails here instead of silently unnaming rows.
    expect(parseMatchRule(routeMatch('www.example.test', '/'))).toEqual({ hosts: ['www.example.test'], path: null, label: null });
    expect(parseMatchRule(routeMatch('example.test', '/shop'))).toEqual({ hosts: ['example.test'], path: '/shop', label: '/shop' });
    expect(parseMatchRule(routeMatch('*.example.test', null))).toEqual({ hosts: ['*.example.test'], path: null, label: null });
    expect(parseMatchRule(routeMatch('*.example.test', '/api'))).toEqual({ hosts: ['*.example.test'], path: '/api', label: '/api' });
    expect(parseMatchRule(hostMatch('*.a-b.example.test'))).toEqual({ hosts: ['*.a-b.example.test'], path: null, label: null });
  });

  it('returns null when no hostname can be read', () => {
    expect(parseMatchRule('PathPrefix(`/`)')).toBeNull();
    // A regexp the platform did not write is not guessed at.
    expect(parseMatchRule('HostRegexp(`^.+$`)')).toBeNull();
    expect(parseMatchRule('')).toBeNull();
  });
});

describe('liveRoutesFromList / indexLiveRoutes', () => {
  const list = {
    items: [
      {
        metadata: { namespace: NS, name: `${NS}-ingress` },
        spec: {
          entryPoints: ['websecure'],
          routes: [
            { match: 'Host(`www.example.test`)', kind: 'Rule', services: [{ name: 'website', port: 80 }] },
            { match: 'Host(`example.test`) && PathPrefix(`/shop`)', kind: 'Rule', services: [{ name: 'shop', port: 80 }] },
          ],
        },
      },
      {
        metadata: { namespace: NS, name: `${NS}-ingress-http` },
        spec: {
          entryPoints: ['web'],
          routes: [{ match: 'Host(`www.example.test`)', kind: 'Rule', services: [{ name: 'website', port: 80 }] }],
        },
      },
      // Malformed entries are skipped, never thrown on.
      { metadata: { name: 'no-namespace' }, spec: { routes: [{ match: 'Host(`x.example.test`)' }] } },
      { metadata: { namespace: NS, name: 'no-spec' } },
      { metadata: { namespace: NS, name: 'bad-route' }, spec: { routes: [{ kind: 'Rule' }, null] } },
      null,
    ],
  };

  it('flattens every route of every object, keeping its object and backend', () => {
    const routes = liveRoutesFromList(list);
    expect(routes).toHaveLength(3);
    expect(routes[0]).toEqual({
      namespace: NS,
      objectName: `${NS}-ingress`,
      entryPoints: ['websecure'],
      match: 'Host(`www.example.test`)',
      backendService: 'website',
    });
    expect(routes[2].entryPoints).toEqual(['web']);
  });

  it('tolerates a body that is not a list at all', () => {
    expect(liveRoutesFromList(undefined)).toEqual([]);
    expect(liveRoutesFromList({ items: 'nope' })).toEqual([]);
  });

  it('indexes each route under the exact label Traefik puts on its series', () => {
    const index = indexLiveRoutes(liveRoutesFromList(list));
    expect(index.get(`${NS}-${NS}-ingress-69f7b9a673940005ba26@kubernetescrd`)?.backendService).toBe('website');
    expect(index.get(`${NS}-${NS}-ingress-147c899de9b819b12821@kubernetescrd`)?.backendService).toBe('shop');
    expect(index.get(`${NS}-${NS}-ingress-http-69f7b9a673940005ba26@kubernetescrd`)?.entryPoints).toEqual(['web']);
    expect(index.size).toBe(3);
  });
});

describe('parseMatchRule — path regexps and methods', () => {
  // The platform's WAF carve-outs: one host, one backend, told apart only
  // by a PathRegexp. Reading only PathPrefix named all three the same.
  it('reads a PathRegexp as a pattern a person can scan', () => {
    const r = parseMatchRule('Host(`admin.example.test`) && PathRegexp(`^/api/v1/tenants/[^/]+/files/upload-raw$`)');
    expect(r?.label).toBe('/api/v1/tenants/*/files/upload-raw');
  });

  it('keeps an unanchored prefix regexp as written', () => {
    const r = parseMatchRule('Host(`admin.example.test`) && PathRegexp(`^/api/v1/admin/security/waf-rule-exclusions`)');
    expect(r?.label).toBe('/api/v1/admin/security/waf-rule-exclusions');
  });

  it('folds a group of alternatives to an ellipsis, and names the method', () => {
    const r = parseMatchRule('Host(`admin.example.test`) && PathRegexp(`^/api/v1/(admin/tenant-bundles/(exports/.+|[^/]+/data-export)|tenants/[^/]+/files/download)$`) && Method(`GET`)');
    expect(r?.label).toBe('/api/v1/… GET');
  });

  it('does not treat a regexp as a plain path when matching route rows', () => {
    const r = parseMatchRule('Host(`admin.example.test`) && PathRegexp(`^/api/v1/tenants/[^/]+/files/upload-raw$`)');
    expect(r?.path).toBeNull();
  });

  it('labels a plain prefix as itself, and a bare host with no label', () => {
    expect(parseMatchRule('Host(`example.test`) && PathPrefix(`/shop`)')?.label).toBe('/shop');
    expect(parseMatchRule('Host(`example.test`)')?.label).toBeNull();
  });
});

import { describe, it, expect, vi } from 'vitest';
import {
  reconcileIngressHosts,
  extractHost,
  buildDesiredRoutes,
  buildIngressRouteBody,
  buildCertificateBody,
} from './ingress-reconciler.js';
import type {
  IngressReconcileDeps,
  IngressRouteCurrentSpec,
  CertificateCurrentSpec,
} from './ingress-reconciler.js';

describe('extractHost', () => {
  it('extracts host from standard https URL', () => {
    expect(extractHost('https://admin.example.com')).toBe('admin.example.com');
  });
  it('extracts host from URL with port', () => {
    expect(extractHost('http://admin.k8s-platform.test:2010')).toBe('admin.k8s-platform.test');
  });
  it('extracts host from URL with path', () => {
    expect(extractHost('https://admin.example.com/panel')).toBe('admin.example.com');
  });
  it('normalizes uppercase hostnames to lowercase', () => {
    expect(extractHost('https://ADMIN.Example.COM')).toBe('admin.example.com');
  });
  it('returns null for empty string', () => {
    expect(extractHost('')).toBeNull();
  });
  it('returns null for null/undefined', () => {
    expect(extractHost(null)).toBeNull();
    expect(extractHost(undefined)).toBeNull();
  });
  it('returns null for malformed URL', () => {
    expect(extractHost('not-a-url')).toBeNull();
    expect(extractHost('://missing-scheme')).toBeNull();
  });
  it('rejects IPv4 literals (cert-manager cannot issue for bare IPs)', () => {
    expect(extractHost('https://192.168.1.1')).toBeNull();
    expect(extractHost('http://10.0.0.1:2010')).toBeNull();
  });
  it('rejects IPv6 literals', () => {
    expect(extractHost('https://[::1]')).toBeNull();
    expect(extractHost('https://[2001:db8::1]')).toBeNull();
  });
  it('rejects localhost and other single-label names', () => {
    expect(extractHost('https://localhost')).toBeNull();
    expect(extractHost('https://intranet')).toBeNull();
  });
  it('accepts nested subdomains', () => {
    expect(extractHost('https://a.b.c.example.com')).toBe('a.b.c.example.com');
  });
  it('rejects labels that start or end with a hyphen', () => {
    expect(extractHost('https://-invalid.example.com')).toBeNull();
    expect(extractHost('https://invalid-.example.com')).toBeNull();
  });
});

describe('buildDesiredRoutes', () => {
  it('emits an admin + tenant route in order', () => {
    const routes = buildDesiredRoutes({
      adminPanelUrl: 'https://admin.example.com',
      tenantPanelUrl: 'https://my.example.com',
      tlsSecretName: 'platform-tls',
    });
    expect(routes).toEqual([
      { host: 'admin.example.com', serviceName: 'admin-panel', oauth2: false },
      { host: 'my.example.com', serviceName: 'tenant-panel', oauth2: false },
    ]);
  });
  it('omits a route when its URL is missing', () => {
    const routes = buildDesiredRoutes({
      adminPanelUrl: 'https://admin.example.com',
      tenantPanelUrl: null,
      tlsSecretName: 'platform-tls',
    });
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ host: 'admin.example.com', serviceName: 'admin-panel' });
  });
  it('sets oauth2 flag when protectAdminViaProxy is true', () => {
    const routes = buildDesiredRoutes({
      adminPanelUrl: 'https://admin.example.com',
      tenantPanelUrl: 'https://my.example.com',
      tlsSecretName: 'platform-tls',
      protectAdminViaProxy: true,
    });
    expect(routes[0].oauth2).toBe(true);
    expect(routes[1].oauth2).toBe(false);
  });
});

describe('buildIngressRouteBody', () => {
  // ── R32: the sign-in redirect must precede the auth check ──────────────
  // A Traefik `errors` middleware only sees responses produced by what comes
  // AFTER it in the chain. Placed after the ForwardAuth it never sees the 401,
  // and an unauthenticated visitor gets a bare 401 page with no way to sign in
  // — which is exactly what both panels did until 2026-09-05.
  it('puts the oauth2 sign-in redirect BEFORE the ForwardAuth', () => {
    const body = buildIngressRouteBody(
      [{ host: 'admin.example.com', serviceName: 'admin-panel', oauth2: true }],
      { namespace: 'platform', name: 'platform-ingress', tlsSecretName: 'platform-tls' },
    );
    const routes = (body.spec as Record<string, unknown>).routes as Array<Record<string, unknown>>;
    const panel = routes.find(r => String(r.match) === 'Host(`admin.example.com`)')!;
    const names = (panel.middlewares as Array<{ name: string }>).map(m => m.name);

    expect(names).toContain('platform-oauth2-proxy-signin');
    expect(names).toContain('platform-oauth2-proxy-auth');
    expect(names.indexOf('platform-oauth2-proxy-signin'))
      .toBeLessThan(names.indexOf('platform-oauth2-proxy-auth'));
  });

  it('attaches neither oauth2 middleware when the panel is not protected', () => {
    const body = buildIngressRouteBody(
      [{ host: 'admin.example.com', serviceName: 'admin-panel', oauth2: false }],
      { namespace: 'platform', name: 'platform-ingress', tlsSecretName: 'platform-tls' },
    );
    const routes = (body.spec as Record<string, unknown>).routes as Array<Record<string, unknown>>;
    const panel = routes.find(r => String(r.match) === 'Host(`admin.example.com`)')!;
    const names = (panel.middlewares as Array<{ name: string }>).map(m => m.name);
    expect(names.some(n => n.startsWith('platform-oauth2-proxy'))).toBe(false);
  });

  it('emits a Host-matching rule + crowdsec + ModSecurity WAF on the panel route', () => {
    const body = buildIngressRouteBody(
      [{ host: 'admin.example.com', serviceName: 'admin-panel', oauth2: false }],
      { namespace: 'platform', name: 'platform-ingress', tlsSecretName: 'platform-tls' },
    );
    expect(body.apiVersion).toBe('traefik.io/v1alpha1');
    expect(body.kind).toBe('IngressRoute');
    const spec = body.spec as Record<string, unknown>;
    expect(spec.entryPoints).toEqual(['websecure']);
    const routes = spec.routes as Array<Record<string, unknown>>;
    // Select by identity, not index: every new carve-out shifts the positions
    // and this assertion used to break for reasons unrelated to what it tests.
    // Carve-outs: /files/upload-raw and the WAF-admin API, plus the panel route.
    expect(routes).toHaveLength(3);
    const panel = routes.find(r => String(r.match) === 'Host(`admin.example.com`)')!;
    expect(panel).toBeDefined();
    expect(panel.match).toBe('Host(`admin.example.com`)');
    expect(panel.kind).toBe('Rule');
    const services = panel.services as Array<Record<string, unknown>>;
    expect(services[0]).toMatchObject({ name: 'admin-panel', port: 80 });
    // Middleware chain — crowdsec runs FIRST so known-bad IPs short-
    // circuit before any other processing. WAF (ModSec) is platform-
    // wide on panel routes regardless of tenant wafEnabled.
    const middlewares = panel.middlewares as Array<{ name: string; namespace: string }>;
    expect(middlewares).toEqual([
      { name: 'crowdsec', namespace: 'traefik' },
      // The body cap MUST sit immediately before the WAF — the plugin reads the
      // whole body with no limit, and one oversized POST OOM-kills ingress.
      { name: 'waf-body-limit', namespace: 'traefik' },
      { name: 'modsecurity-crs', namespace: 'traefik' },
    ]);
    expect(spec.tls).toEqual({ secretName: 'platform-tls' });
  });

  // The ModSecurity plugin buffers the WHOLE request body in the Traefik pod
  // (unbounded — its `maxBodySize` knob is not a field of the plugin's Config
  // struct) and mirrors it to the sidecar, which spools it to disk. Traefik is
  // a DaemonSet with limits.memory=512Mi fronting the entire cluster, and CRS
  // exclusion 9000105 already strips REQUEST_BODY/ARGS_POST for this URI — so
  // the mirroring is pure cost. The upload path must bypass the WAF middleware.
  // A rule exclusion describes an attack pattern — that is its purpose. With
  // the WAF in front of the endpoint that stores one, the operator cannot
  // disarm a false positive: the safety valve sits behind the thing it
  // disarms. Hit in production 2026-08-30 — a tenant could not rename
  // `.htaccess` (CRS 930120) and the whitelist request was itself blocked,
  // by a message telling the operator to go and whitelist it.
  it('routes the WAF-admin API around the WAF so a false positive can be disarmed', () => {
    const body = buildIngressRouteBody(
      [{ host: 'admin.example.com', serviceName: 'admin-panel', oauth2: false }],
      { namespace: 'platform', name: 'platform-ingress', tlsSecretName: 'platform-tls' },
    );
    const routes = (body.spec as Record<string, unknown>).routes as Array<Record<string, unknown>>;
    const wafAdmin = routes.find(r => String(r.match).includes('waf-rule-exclusions'));
    expect(wafAdmin).toBeDefined();
    expect(wafAdmin!.match).toBe(
      'Host(`admin.example.com`) && PathRegexp(`^/api/v1/admin/security/waf-rule-exclusions`)',
    );
    const mw = wafAdmin!.middlewares as Array<{ name: string }>;
    const names = mw.map(m => m.name);
    // The WAF must be gone…
    expect(names).not.toContain('modsecurity-crs');
    // …but crowdsec and the body cap stay: an exclusion is a small JSON
    // document, so there is no reason to let it be unbounded, and IP
    // reputation is orthogonal to rule matching.
    expect(names).toContain('crowdsec');
    expect(names).toContain('waf-body-limit');
    // It must outrank the bare Host() panel route or it never matches.
    expect(wafAdmin!.priority).toBe(101);
  });

  it('routes /files/upload-raw around the WAF so upload bodies are never buffered', () => {
    const body = buildIngressRouteBody(
      [{ host: 'tenant.example.com', serviceName: 'tenant-panel', oauth2: false }],
      { namespace: 'platform', name: 'platform-ingress', tlsSecretName: 'platform-tls' },
    );
    const routes = (body.spec as { routes: Array<Record<string, unknown>> }).routes;
    const upload = routes.find(r => String(r.match).includes('upload-raw'));
    expect(upload).toBeDefined();
    expect(upload!.match).toBe(
      'Host(`tenant.example.com`) && PathRegexp(`^/api/v1/tenants/[^/]+/files/upload-raw$`)',
    );
    // Must out-prioritise both the bare Host() panel route and the /oauth2
    // route (100), or Traefik's rule-length heuristic could pick the wrong one.
    expect(upload!.priority).toBe(101);
    const mw = upload!.middlewares as Array<{ name: string }>;
    expect(mw.map(m => m.name)).not.toContain('modsecurity-crs');
    // The cap goes too: it exists only to bound what the WAF buffers, and a
    // 12.5 MiB ceiling on the streaming upload path would defeat the point.
    expect(mw.map(m => m.name)).not.toContain('waf-body-limit');
    // CrowdSec still applies — only body mirroring is skipped.
    expect(mw.map(m => m.name)).toEqual(['crowdsec']);
    // Same backend as the panel route.
    expect((upload!.services as Array<Record<string, unknown>>)[0])
      .toMatchObject({ name: 'tenant-panel', port: 80 });
  });

  it('keeps ForwardAuth on the upload carve-out when oauth2 is enabled', () => {
    // Dropping the WAF must not accidentally drop authentication.
    const body = buildIngressRouteBody(
      [{ host: 'admin.example.com', serviceName: 'admin-panel', oauth2: true }],
      { namespace: 'platform', name: 'platform-ingress', tlsSecretName: 'platform-tls' },
    );
    const routes = (body.spec as { routes: Array<Record<string, unknown>> }).routes;
    const upload = routes.find(r => String(r.match).includes('upload-raw'))!;
    const mw = upload.middlewares as Array<{ name: string; namespace: string }>;
    // The sign-in redirect rides along with the ForwardAuth everywhere it is
    // attached — an upload that 401s must still be able to send the caller to
    // the IdP rather than dead-ending.
    expect(mw).toEqual([
      { name: 'crowdsec', namespace: 'traefik' },
      { name: 'platform-oauth2-proxy-signin', namespace: 'platform' },
      { name: 'platform-oauth2-proxy-auth', namespace: 'platform' },
    ]);
  });

  it('emits one upload carve-out per host', () => {
    const body = buildIngressRouteBody(
      [
        { host: 'admin.example.com', serviceName: 'admin-panel', oauth2: false },
        { host: 'tenant.example.com', serviceName: 'tenant-panel', oauth2: false },
      ],
      { namespace: 'platform', name: 'platform-ingress', tlsSecretName: 'platform-tls' },
    );
    const routes = (body.spec as { routes: Array<Record<string, unknown>> }).routes;
    const uploads = routes.filter(r => String(r.match).includes('upload-raw'));
    expect(uploads).toHaveLength(2);
    expect(uploads.map(u => u.match)).toEqual([
      'Host(`admin.example.com`) && PathRegexp(`^/api/v1/tenants/[^/]+/files/upload-raw$`)',
      'Host(`tenant.example.com`) && PathRegexp(`^/api/v1/tenants/[^/]+/files/upload-raw$`)',
    ]);
  });
  it('adds a priority-100 /oauth2 prefix route + crowdsec → ForwardAuth → WAF chain on the panel route when oauth2 is enabled', () => {
    const body = buildIngressRouteBody(
      [{ host: 'admin.example.com', serviceName: 'admin-panel', oauth2: true }],
      { namespace: 'platform', name: 'platform-ingress', tlsSecretName: 'platform-tls' },
    );
    const routes = (body.spec as { routes: Array<Record<string, unknown>> }).routes;
    // [0] = /oauth2, [1] = upload carve-out, [2] = panel route.
    // upload carve-out + WAF-admin carve-out + /oauth2 + panel route
    expect(routes).toHaveLength(4);
    // /oauth2 priority route — no auth Middleware (oauth2-proxy IS the auth endpoint).
    expect(routes[0].match).toBe('Host(`admin.example.com`) && PathPrefix(`/oauth2`)');
    expect(routes[0].priority).toBe(100);
    expect((routes[0].services as Array<Record<string, unknown>>)[0]).toEqual({
      name: 'oauth2-proxy',
      port: 4180,
    });
    // Panel route — crowdsec → signin-redirect → ForwardAuth → WAF, in that
    // order. The redirect must precede the ForwardAuth: a Traefik `errors`
    // middleware only sees responses from what follows it, so reversed it never
    // catches the 401 and the visitor dead-ends (R32).
    const panelRoute = routes.find(r => String(r.match) === 'Host(`admin.example.com`)')!;
    expect(panelRoute).toBeDefined();
    const panelMiddlewares = panelRoute.middlewares as Array<{ name: string; namespace: string }>;
    expect(panelMiddlewares).toEqual([
      { name: 'crowdsec', namespace: 'traefik' },
      { name: 'platform-oauth2-proxy-signin', namespace: 'platform' },
      { name: 'platform-oauth2-proxy-auth', namespace: 'platform' },
      { name: 'waf-body-limit', namespace: 'traefik' },
      { name: 'modsecurity-crs', namespace: 'traefik' },
    ]);
  });
});

describe('buildCertificateBody', () => {
  it('emits a cert-manager Certificate with the desired hostnames + issuer', () => {
    const body = buildCertificateBody(['admin.example.com', 'my.example.com'], {
      namespace: 'platform',
      name: 'platform-ingress',
      secretName: 'platform-tls',
      issuerName: 'letsencrypt-prod-http01',
    });
    expect(body.apiVersion).toBe('cert-manager.io/v1');
    expect(body.kind).toBe('Certificate');
    const spec = body.spec as Record<string, unknown>;
    expect(spec.dnsNames).toEqual(['admin.example.com', 'my.example.com']);
    expect(spec.secretName).toBe('platform-tls');
    expect(spec.issuerRef).toEqual({
      name: 'letsencrypt-prod-http01',
      kind: 'ClusterIssuer',
      group: 'cert-manager.io',
    });
  });
});

function mockDeps(
  currentIngress?: IngressRouteCurrentSpec | null,
  currentCert?: CertificateCurrentSpec | null,
): IngressReconcileDeps {
  return {
    readIngressRoute: vi.fn().mockResolvedValue(currentIngress ?? null),
    readCertificate: vi.fn().mockResolvedValue(currentCert ?? null),
    applyIngressRoute: vi.fn().mockResolvedValue(undefined),
    applyCertificate: vi.fn().mockResolvedValue(undefined),
  };
}

describe('reconcileIngressHosts', () => {
  it('applies fresh routes + cert when neither resource exists yet', async () => {
    const deps = mockDeps();
    const result = await reconcileIngressHosts({
      adminPanelUrl: 'https://admin.example.com',
      tenantPanelUrl: 'https://my.example.com',
      tlsSecretName: 'platform-tls',
    }, deps);
    expect(result.changed).toBe(true);
    expect(deps.applyCertificate).toHaveBeenCalledTimes(1);
    expect(deps.applyIngressRoute).toHaveBeenCalledTimes(1);
    const certApplied = (deps.applyCertificate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const ingressApplied = (deps.applyIngressRoute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(certApplied.spec.dnsNames).toEqual(['admin.example.com', 'my.example.com']);
    // 2 hosts x (upload carve-out + panel route).
    // 2 hosts x (upload carve-out + WAF-admin carve-out + panel route)
    expect(ingressApplied.spec.routes).toHaveLength(6);
  });

  // Regression: the carve-out shares host + backend with the panel route, so the
  // host/service comparison cannot see it. On the first rollout that made every
  // existing cluster look permanently in-sync — the route was built correctly and
  // never applied, and DEV came back with "no upload-raw route in platform-ingress".
  it('re-applies when the live route predates the upload carve-out', async () => {
    const deps = mockDeps(
      {
        routes: [
          { host: 'admin.example.com', serviceName: 'admin-panel', oauth2Backend: null, uploadCarveOut: false },
        ],
        tlsSecret: 'platform-tls',
      },
      {
        dnsNames: ['admin.example.com'],
        secretName: 'platform-tls',
        issuerName: 'letsencrypt-prod-http01',
      },
    );
    const result = await reconcileIngressHosts({
      adminPanelUrl: 'https://admin.example.com',
      tenantPanelUrl: null,
      tlsSecretName: 'platform-tls',
    }, deps);
    expect(result.changed).toBe(true);
    expect(deps.applyIngressRoute).toHaveBeenCalled();
    const applied = (deps.applyIngressRoute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(applied.spec.routes.some((r: { match: string }) => r.match.includes('upload-raw'))).toBe(true);
  });

  it('is a no-op when desired routes + cert match the live resources', async () => {
    const deps = mockDeps(
      {
        routes: [
          // Both carve-outs must be present for this to be a no-op. A cluster
          // whose live IngressRoute predates either one is legitimately out of
          // sync and MUST be re-applied — that is the whole point of tracking
          // them in the comparison (see #300, where a correct carve-out was
          // never applied because the reconciler thought it was in sync).
          { host: 'admin.example.com', serviceName: 'admin-panel', oauth2Backend: null, uploadCarveOut: true, wafAdminCarveOut: true },
          { host: 'my.example.com', serviceName: 'tenant-panel', oauth2Backend: null, uploadCarveOut: true, wafAdminCarveOut: true },
        ],
        tlsSecret: 'platform-tls',
      },
      {
        dnsNames: ['admin.example.com', 'my.example.com'],
        secretName: 'platform-tls',
        issuerName: 'letsencrypt-prod-http01',
      },
    );
    const result = await reconcileIngressHosts({
      adminPanelUrl: 'https://admin.example.com',
      tenantPanelUrl: 'https://my.example.com',
      tlsSecretName: 'platform-tls',
    }, deps);
    expect(result.changed).toBe(false);
    expect(deps.applyIngressRoute).not.toHaveBeenCalled();
    expect(deps.applyCertificate).not.toHaveBeenCalled();
  });

  it('skips reconcile if neither URL is set — never produces an empty IngressRoute', async () => {
    const deps = mockDeps();
    const result = await reconcileIngressHosts({
      adminPanelUrl: null,
      tenantPanelUrl: null,
      tlsSecretName: 'platform-tls',
    }, deps);
    expect(result.changed).toBe(false);
    expect(deps.applyIngressRoute).not.toHaveBeenCalled();
  });

  it('omits a route + dnsName if only one URL is set', async () => {
    const deps = mockDeps();
    await reconcileIngressHosts({
      adminPanelUrl: 'https://admin.example.com',
      tenantPanelUrl: null,
      tlsSecretName: 'platform-tls',
    }, deps);
    const ingressApplied = (deps.applyIngressRoute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // upload carve-out + panel route for the one surviving host.
    expect(ingressApplied.spec.routes).toHaveLength(3);
    expect(ingressApplied.spec.routes.some((r: { match?: string }) => r.match === 'Host(`admin.example.com`)')).toBe(true);
    const certApplied = (deps.applyCertificate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(certApplied.spec.dnsNames).toEqual(['admin.example.com']);
  });

  it('ignores a malformed URL instead of producing a host-less route', async () => {
    const deps = mockDeps();
    await reconcileIngressHosts({
      adminPanelUrl: 'not-a-url',
      tenantPanelUrl: 'https://my.example.com',
      tlsSecretName: 'platform-tls',
    }, deps);
    const ingressApplied = (deps.applyIngressRoute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // upload carve-out + panel route for the one surviving host.
    expect(ingressApplied.spec.routes).toHaveLength(3);
    expect(ingressApplied.spec.routes.some((r: { match?: string }) => r.match === 'Host(`my.example.com`)')).toBe(true);
  });

  describe('oauth2-proxy /oauth2 path routing', () => {
    it('emits a /oauth2 prefix route on the admin host when protectAdminViaProxy is true', async () => {
      const deps = mockDeps();
      await reconcileIngressHosts({
        adminPanelUrl: 'https://admin.example.com',
        tenantPanelUrl: 'https://my.example.com',
        tlsSecretName: 'platform-tls',
        protectAdminViaProxy: true,
      }, deps);
      const ingressApplied = (deps.applyIngressRoute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // admin: /oauth2 + upload + waf-admin + panel; tenant: upload + waf-admin + panel.
      expect(ingressApplied.spec.routes).toHaveLength(7);
      const oauth2Route = ingressApplied.spec.routes.find(
        (r: { match: string }) => r.match === 'Host(`admin.example.com`) && PathPrefix(`/oauth2`)',
      );
      expect(oauth2Route).toBeDefined();
      expect(oauth2Route.priority).toBe(100);
      expect(oauth2Route.services[0]).toEqual({ name: 'oauth2-proxy', port: 4180 });
    });

    it('adds /oauth2 to the tenant host when protectTenantViaProxy is true (admin unchanged)', async () => {
      const deps = mockDeps();
      await reconcileIngressHosts({
        adminPanelUrl: 'https://admin.example.com',
        tenantPanelUrl: 'https://my.example.com',
        tlsSecretName: 'platform-tls',
        protectTenantViaProxy: true,
      }, deps);
      const ingressApplied = (deps.applyIngressRoute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const oauth2Routes = ingressApplied.spec.routes.filter(
        (r: { match: string }) => /PathPrefix\(`\/oauth2`\)/.test(r.match),
      );
      expect(oauth2Routes).toHaveLength(1);
      expect(oauth2Routes[0].match).toBe('Host(`my.example.com`) && PathPrefix(`/oauth2`)');
    });

    it('emits /oauth2 on both hosts when both panels are protected', async () => {
      const deps = mockDeps();
      await reconcileIngressHosts({
        adminPanelUrl: 'https://admin.example.com',
        tenantPanelUrl: 'https://my.example.com',
        tlsSecretName: 'platform-tls',
        protectAdminViaProxy: true,
        protectTenantViaProxy: true,
      }, deps);
      const ingressApplied = (deps.applyIngressRoute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const oauth2Routes = ingressApplied.spec.routes.filter(
        (r: { match: string }) => /PathPrefix\(`\/oauth2`\)/.test(r.match),
      );
      expect(oauth2Routes).toHaveLength(2);
    });

    it('reconciles when toggling protection (current has no /oauth2, desired does)', async () => {
      const deps = mockDeps(
        {
          routes: [
            { host: 'admin.example.com', serviceName: 'admin-panel', oauth2Backend: null },
            { host: 'my.example.com', serviceName: 'tenant-panel', oauth2Backend: null },
          ],
          tlsSecret: 'platform-tls',
        },
        {
          dnsNames: ['admin.example.com', 'my.example.com'],
          secretName: 'platform-tls',
          issuerName: 'letsencrypt-prod-http01',
        },
      );
      const result = await reconcileIngressHosts({
        adminPanelUrl: 'https://admin.example.com',
        tenantPanelUrl: 'https://my.example.com',
        tlsSecretName: 'platform-tls',
        protectAdminViaProxy: true,
      }, deps);
      expect(result.changed).toBe(true);
      expect(deps.applyIngressRoute).toHaveBeenCalled();
    });
  });
});

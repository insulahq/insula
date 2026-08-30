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
    // [0] = upload carve-out, [1] = panel route.
    expect(routes).toHaveLength(2);
    const panel = routes[1];
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
    expect(mw).toEqual([
      { name: 'crowdsec', namespace: 'traefik' },
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
    expect(routes).toHaveLength(3);
    // /oauth2 priority route — no auth Middleware (oauth2-proxy IS the auth endpoint).
    expect(routes[0].match).toBe('Host(`admin.example.com`) && PathPrefix(`/oauth2`)');
    expect(routes[0].priority).toBe(100);
    expect((routes[0].services as Array<Record<string, unknown>>)[0]).toEqual({
      name: 'oauth2-proxy',
      port: 4180,
    });
    // Panel route — crowdsec → ForwardAuth → WAF (in that order).
    expect(routes[2].match).toBe('Host(`admin.example.com`)');
    const panelMiddlewares = routes[2].middlewares as Array<{ name: string; namespace: string }>;
    expect(panelMiddlewares).toEqual([
      { name: 'crowdsec', namespace: 'traefik' },
      { name: 'platform-oauth2-proxy-auth', namespace: 'platform' },
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
    expect(ingressApplied.spec.routes).toHaveLength(4);
  });

  it('is a no-op when desired routes + cert match the live resources', async () => {
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
    expect(ingressApplied.spec.routes).toHaveLength(2);
    expect(ingressApplied.spec.routes[1].match).toBe('Host(`admin.example.com`)');
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
    expect(ingressApplied.spec.routes).toHaveLength(2);
    expect(ingressApplied.spec.routes[1].match).toBe('Host(`my.example.com`)');
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
      // admin: /oauth2 + upload + panel; tenant: upload + panel.
      expect(ingressApplied.spec.routes).toHaveLength(5);
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

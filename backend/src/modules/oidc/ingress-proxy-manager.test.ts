import { describe, it, expect, vi } from 'vitest';
import {
  syncProxyIngressAnnotations,
} from './ingress-proxy-manager.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface CustomObjectsApiCalls {
  getNamespacedCustomObject: ReturnType<typeof vi.fn>;
  replaceNamespacedCustomObject: ReturnType<typeof vi.fn>;
  createNamespacedCustomObject: ReturnType<typeof vi.fn>;
  deleteNamespacedCustomObject: ReturnType<typeof vi.fn>;
  listNamespacedCustomObject: ReturnType<typeof vi.fn>;
}

function makeK8s(existing: Record<string, Record<string, unknown>> = {}): K8sClients & {
  custom: CustomObjectsApiCalls;
} {
  // Mock CustomObjectsApi. Each Get returns a stored resource or 404.
  const get = vi.fn(async (args: { plural: string; namespace: string; name: string }) => {
    const key = `${args.namespace}/${args.plural}/${args.name}`;
    if (key in existing) return existing[key];
    const err: Error & { statusCode?: number } = Object.assign(new Error('not found'), { statusCode: 404 });
    throw err;
  });
  const create = vi.fn(async (args: { plural: string; namespace: string; body: Record<string, unknown> }) => {
    const meta = (args.body as { metadata?: { name?: string } }).metadata;
    const name = meta?.name ?? 'unknown';
    existing[`${args.namespace}/${args.plural}/${name}`] = args.body;
    return args.body;
  });
  const replace = vi.fn(async (args: { plural: string; namespace: string; name: string; body: Record<string, unknown> }) => {
    existing[`${args.namespace}/${args.plural}/${args.name}`] = args.body;
    return args.body;
  });
  const del = vi.fn(async (args: { plural: string; namespace: string; name: string }) => {
    const key = `${args.namespace}/${args.plural}/${args.name}`;
    if (!(key in existing)) {
      const err: Error & { statusCode?: number } = Object.assign(new Error('not found'), { statusCode: 404 });
      throw err;
    }
    delete existing[key];
    return {};
  });
  const list = vi.fn(async (_args: { plural: string; namespace: string }) => ({ items: [] }));
  return {
    custom: {
      getNamespacedCustomObject: get,
      replaceNamespacedCustomObject: replace,
      createNamespacedCustomObject: create,
      deleteNamespacedCustomObject: del,
      listNamespacedCustomObject: list,
    },
    core: {
      patchNamespacedSecret: vi.fn(),
      createNamespacedSecret: vi.fn(),
    },
  } as unknown as K8sClients & { custom: CustomObjectsApiCalls };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('syncProxyIngressAnnotations — per-panel Middlewares', () => {
  function createdMiddleware(k8s: ReturnType<typeof makeK8s>, name: string) {
    const calls = (k8s.custom.createNamespacedCustomObject as ReturnType<typeof vi.fn>).mock.calls;
    const call = calls.find((c) =>
      c[0].plural === 'middlewares' && (c[0].body as { metadata: { name: string } }).metadata.name === name);
    return call?.[0].body as { spec: Record<string, any> } | undefined;
  }

  it('creates ONLY the protected panel\'s pair, pointing at that panel\'s own proxy', async () => {
    const k8s = makeK8s();
    await syncProxyIngressAnnotations(k8s, {
      protectAdminViaProxy: false,
      protectTenantViaProxy: true,
      breakGlassPath: null,
      adminHost: 'admin.example.com',
    });
    const auth = createdMiddleware(k8s, 'platform-oauth2-proxy-auth-tenant');
    expect(auth?.spec.forwardAuth.address).toBe('http://oauth2-proxy-tenant.platform.svc.cluster.local:4180/oauth2/auth');
    // Identity only — the IdP access token is not handed to the panel.
    expect(auth?.spec.forwardAuth.authResponseHeaders).toEqual(['X-Auth-Request-User', 'X-Auth-Request-Email']);
    const signin = createdMiddleware(k8s, 'platform-oauth2-proxy-signin-tenant');
    expect(signin?.spec.errors.service).toEqual({ name: 'oauth2-proxy-tenant', port: 4180 });
    expect(createdMiddleware(k8s, 'platform-oauth2-proxy-auth-admin')).toBeUndefined();
  });

  it('deletes an unprotected panel\'s pair', async () => {
    const name = 'platform-oauth2-proxy-auth-admin';
    const k8s = makeK8s({
      [`platform/middlewares/${name}`]: {
        apiVersion: 'traefik.io/v1alpha1', kind: 'Middleware',
        metadata: { name, namespace: 'platform' }, spec: {},
      },
    });
    await syncProxyIngressAnnotations(k8s, {
      protectAdminViaProxy: false,
      protectTenantViaProxy: false,
      breakGlassPath: null,
      adminHost: 'admin.example.com',
    });
    expect(k8s.custom.deleteNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ plural: 'middlewares', name }),
    );
  });
});

describe('syncProxyIngressAnnotations — break-glass IngressRoute', () => {
  it('creates the break-glass IngressRoute with stripPrefix Middleware when configured', async () => {
    const k8s = makeK8s();
    await syncProxyIngressAnnotations(k8s, {
      protectAdminViaProxy: true,
      protectTenantViaProxy: false,
      breakGlassPath: 'emergency-admin',
      adminHost: 'admin.example.com',
    });
    const calls = (k8s.custom.createNamespacedCustomObject as ReturnType<typeof vi.fn>).mock.calls;
    const breakGlassCall = calls.find((c) =>
      c[0].plural === 'ingressroutes'
      && (c[0].body as { metadata: { name: string } }).metadata.name === 'platform-break-glass-ingress',
    );
    expect(breakGlassCall).toBeDefined();
    const body = breakGlassCall![0].body as {
      spec: {
        routes: Array<{
          match: string;
          priority?: number;
          middlewares?: Array<{ name: string }>;
          services: Array<{ name: string; port: number }>;
        }>;
      };
    };
    expect(body.spec.routes).toHaveLength(1);
    expect(body.spec.routes[0].match).toContain('admin.example.com');
    expect(body.spec.routes[0].match).toContain('/emergency-admin');
    expect(body.spec.routes[0].priority).toBe(100);
    expect(body.spec.routes[0].services[0]).toEqual({ name: 'admin-panel', port: 80 });
    // Strip-prefix Middleware reference present.
    expect(body.spec.routes[0].middlewares?.[0].name).toMatch(/strip$/);
    // Strip Middleware itself was applied (one of the create calls).
    const stripCall = calls.find((c) =>
      c[0].plural === 'middlewares'
      && (c[0].body as { metadata: { name: string } }).metadata.name.endsWith('-strip'),
    );
    expect(stripCall).toBeDefined();
    const stripBody = stripCall![0].body as { spec: { stripPrefix?: { prefixes: string[] } } };
    expect(stripBody.spec.stripPrefix?.prefixes).toEqual(['/emergency-admin']);
  });

  it('does not create break-glass IngressRoute when protectAdminViaProxy is false', async () => {
    const k8s = makeK8s();
    await syncProxyIngressAnnotations(k8s, {
      protectAdminViaProxy: false,
      protectTenantViaProxy: false,
      breakGlassPath: 'emergency-admin',
      adminHost: 'admin.example.com',
    });
    const calls = (k8s.custom.createNamespacedCustomObject as ReturnType<typeof vi.fn>).mock.calls;
    const breakGlassCall = calls.find((c) =>
      c[0].plural === 'ingressroutes'
      && (c[0].body as { metadata: { name: string } }).metadata.name === 'platform-break-glass-ingress',
    );
    expect(breakGlassCall).toBeUndefined();
  });

  it('does not create break-glass when breakGlassPath is null', async () => {
    const k8s = makeK8s();
    await syncProxyIngressAnnotations(k8s, {
      protectAdminViaProxy: true,
      protectTenantViaProxy: false,
      breakGlassPath: null,
      adminHost: 'admin.example.com',
    });
    const calls = (k8s.custom.createNamespacedCustomObject as ReturnType<typeof vi.fn>).mock.calls;
    const breakGlassCall = calls.find((c) =>
      c[0].plural === 'ingressroutes'
      && (c[0].body as { metadata: { name: string } }).metadata.name === 'platform-break-glass-ingress',
    );
    expect(breakGlassCall).toBeUndefined();
  });

  it('skips break-glass IngressRoute creation when adminHost is null', async () => {
    const k8s = makeK8s();
    await syncProxyIngressAnnotations(k8s, {
      protectAdminViaProxy: true,
      protectTenantViaProxy: false,
      breakGlassPath: 'emergency-admin',
      adminHost: null,
    });
    const calls = (k8s.custom.createNamespacedCustomObject as ReturnType<typeof vi.fn>).mock.calls;
    const breakGlassCall = calls.find((c) =>
      c[0].plural === 'ingressroutes'
      && (c[0].body as { metadata: { name: string } }).metadata.name === 'platform-break-glass-ingress',
    );
    expect(breakGlassCall).toBeUndefined();
  });
});

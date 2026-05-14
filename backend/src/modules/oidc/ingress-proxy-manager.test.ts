import { describe, it, expect, vi } from 'vitest';
import {
  syncProxyIngressAnnotations,
  OAUTH2_PROXY_MIDDLEWARE_NAME,
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

const db = {} as never;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('syncProxyIngressAnnotations — ForwardAuth Middleware', () => {
  it('creates the platform-oauth2-proxy-auth Middleware when protect is on', async () => {
    const k8s = makeK8s();
    await syncProxyIngressAnnotations(db, k8s, {
      protectAdminViaProxy: true,
      protectClientViaProxy: false,
      breakGlassPath: null,
      adminHost: 'admin.example.com',
    });
    // Middleware should have been created in platform namespace.
    expect(k8s.custom.createNamespacedCustomObject).toHaveBeenCalled();
    const calls = (k8s.custom.createNamespacedCustomObject as ReturnType<typeof vi.fn>).mock.calls;
    const middlewareCall = calls.find((c) =>
      c[0].plural === 'middlewares'
      && (c[0].body as { metadata: { name: string } }).metadata.name === OAUTH2_PROXY_MIDDLEWARE_NAME,
    );
    expect(middlewareCall).toBeDefined();
    const body = middlewareCall![0].body as { spec: { forwardAuth?: { address: string } } };
    expect(body.spec.forwardAuth?.address).toBe('http://oauth2-proxy.platform.svc.cluster.local:4180/oauth2/auth');
  });

  it('deletes the Middleware when both protect flags are off', async () => {
    // Seed an existing Middleware so delete has something to remove.
    const initial: Record<string, Record<string, unknown>> = {};
    initial[`platform/middlewares/${OAUTH2_PROXY_MIDDLEWARE_NAME}`] = {
      apiVersion: 'traefik.io/v1alpha1',
      kind: 'Middleware',
      metadata: { name: OAUTH2_PROXY_MIDDLEWARE_NAME, namespace: 'platform' },
      spec: { forwardAuth: { address: 'http://oauth2-proxy.platform.svc.cluster.local:4180/oauth2/auth' } },
    };
    const k8s = makeK8s(initial);
    await syncProxyIngressAnnotations(db, k8s, {
      protectAdminViaProxy: false,
      protectClientViaProxy: false,
      breakGlassPath: null,
      adminHost: 'admin.example.com',
    });
    expect(k8s.custom.deleteNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ plural: 'middlewares', name: OAUTH2_PROXY_MIDDLEWARE_NAME }),
    );
  });
});

describe('syncProxyIngressAnnotations — break-glass IngressRoute', () => {
  it('creates the break-glass IngressRoute with stripPrefix Middleware when configured', async () => {
    const k8s = makeK8s();
    await syncProxyIngressAnnotations(db, k8s, {
      protectAdminViaProxy: true,
      protectClientViaProxy: false,
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
    await syncProxyIngressAnnotations(db, k8s, {
      protectAdminViaProxy: false,
      protectClientViaProxy: false,
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
    await syncProxyIngressAnnotations(db, k8s, {
      protectAdminViaProxy: true,
      protectClientViaProxy: false,
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
    await syncProxyIngressAnnotations(db, k8s, {
      protectAdminViaProxy: true,
      protectClientViaProxy: false,
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

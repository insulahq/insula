import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The ordering invariant of the sync, in both directions: a route never
 * references a proxy or Middleware that does not exist yet (enable), and never
 * keeps referencing one that was already deleted (disable). Both broke a panel
 * host: Traefik drops a route whose Service or Middleware is missing.
 */
const calls: string[] = [];
let settings: Record<string, unknown> = {};

vi.mock('./service.js', () => ({
  getGlobalSettings: vi.fn(async () => settings),
  getDecryptedCookieSecret: vi.fn(async () => 'c'.repeat(32)),
  loadPanelProxyProvider: vi.fn(async (_db: unknown, id: string | null) =>
    id ? { issuerUrl: 'https://id.example.test', clientId: 'c', clientSecret: 's' } : null),
}));
vi.mock('../system-settings/service.js', () => ({
  getSettings: vi.fn(async () => ({ adminPanelUrl: 'https://admin.example.test', tenantPanelUrl: 'https://tenant.example.test' })),
}));
vi.mock('../system-settings/ingress-reconciler.js', () => ({
  extractHost: (u: string | null) => (u ? new URL(u).host : null),
  reconcileIngressHosts: vi.fn(async (input: { protectTenantViaProxy?: boolean }) => {
    calls.push(`routes(tenant=${input.protectTenantViaProxy ? 'proxied' : 'plain'})`);
    return { changed: true };
  }),
}));
vi.mock('./panel-proxy.js', () => ({
  applyPanelProxy: vi.fn(async (_k: unknown, cfg: { panel: string }) => { calls.push(`applyProxy(${cfg.panel})`); }),
  waitPanelProxyReady: vi.fn(async (_k: unknown, panel: string) => { calls.push(`ready(${panel})`); }),
  removePanelProxy: vi.fn(async (_k: unknown, panel: string) => { calls.push(`removeProxy(${panel})`); }),
}));
vi.mock('./ingress-proxy-manager.js', () => ({
  syncProxyIngressAnnotations: vi.fn(async (_k: unknown, s: { protectTenantViaProxy: boolean }, opts: { deleteUnprotected?: boolean }) => {
    if (s.protectTenantViaProxy) calls.push('applyMiddlewares(tenant)');
    if (opts?.deleteUnprotected !== false && !s.protectTenantViaProxy) calls.push('deleteMiddlewares(tenant)');
  }),
  deletePanelMiddlewares: vi.fn(async (_k: unknown, panel: string) => { calls.push(`deleteMiddlewares(${panel})`); }),
  deleteLegacySharedMiddlewares: vi.fn(async () => { calls.push('deleteLegacy'); }),
}));

const { syncPanelProxies } = await import('./panel-proxy-sync.js');
const cfg = { encryptionKey: '0'.repeat(64), tlsSecretName: 'platform-tls' };
const k8s = {} as never;
const db = {} as never;

beforeEach(() => { calls.length = 0; });

describe('syncPanelProxies ordering', () => {
  it('enable: proxy, ready, Middlewares — and only then the routes', async () => {
    settings = { protectAdminViaProxy: false, protectTenantViaProxy: true, proxyTenantProviderId: 'p1', proxyAdminProviderId: null, breakGlassPath: null };
    await syncPanelProxies(db, cfg, { waitReady: true, k8s });
    const i = (s: string) => calls.indexOf(s);
    expect(i('applyProxy(tenant)')).toBeLessThan(i('ready(tenant)'));
    expect(i('ready(tenant)')).toBeLessThan(i('applyMiddlewares(tenant)'));
    expect(i('applyMiddlewares(tenant)')).toBeLessThan(i('routes(tenant=proxied)'));
    expect(calls).not.toContain('removeProxy(tenant)');
  });

  it('disable: the routes stop referencing the Middlewares BEFORE they and the proxy are deleted', async () => {
    settings = { protectAdminViaProxy: false, protectTenantViaProxy: false, proxyTenantProviderId: 'p1', proxyAdminProviderId: null, breakGlassPath: null };
    await syncPanelProxies(db, cfg, { waitReady: false, k8s });
    const i = (s: string) => calls.indexOf(s);
    expect(i('routes(tenant=plain)')).toBeGreaterThanOrEqual(0);
    expect(i('routes(tenant=plain)')).toBeLessThan(i('deleteMiddlewares(tenant)'));
    expect(i('routes(tenant=plain)')).toBeLessThan(i('removeProxy(tenant)'));
    expect(i('routes(tenant=plain)')).toBeLessThan(i('deleteLegacy'));
  });

  it('refuses to touch the routes when a protected panel has no usable provider', async () => {
    settings = { protectAdminViaProxy: false, protectTenantViaProxy: true, proxyTenantProviderId: null, proxyAdminProviderId: null, breakGlassPath: null };
    await expect(syncPanelProxies(db, cfg, { waitReady: true, k8s })).rejects.toMatchObject({ code: 'OAUTH2_PROXY_MISCONFIGURED' });
    expect(calls.some((c) => c.startsWith('routes('))).toBe(false);
  });
});

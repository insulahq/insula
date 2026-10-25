import { describe, it, expect, vi, beforeEach } from 'vitest';

const apply = vi.hoisted(() => ({
  applyIngressRoute: vi.fn(async () => undefined),
  deleteIngressRoute: vi.fn(async () => undefined),
}));
vi.mock('../ingress-routes/traefik-apply.js', () => apply);
vi.mock('../webmail-settings/service.js', () => ({
  getDefaultWebmailUrl: vi.fn(async () => 'https://webmail.platform.test/'),
}));

import { buildWebmailHttpRoute, reconcileWebmailHttpRoutes, webmailRouteNames } from './webmail-http-route.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

beforeEach(() => { vi.clearAllMocks(); });

describe('buildWebmailHttpRoute', () => {
  const route = buildWebmailHttpRoute({ namespace: 'tenant-a', domainName: 'example.test' });

  it('serves the plain-HTTP entrypoint with the https route\'s own redirect Middleware', () => {
    expect(route.spec.entryPoints).toEqual(['web']);
    expect(route.spec.routes[0].middlewares).toEqual([
      { name: webmailRouteNames('webmail.example.test').middlewareName, namespace: 'tenant-a' },
    ]);
    expect(route.spec.tls).toBeUndefined();
  });

  it('leaves ACME HTTP-01 challenges for the hostname alone', () => {
    expect(route.spec.routes[0].match).toBe(
      'Host(`webmail.example.test`) && !PathPrefix(`/.well-known/acme-challenge/`)',
    );
  });

  it('is named apart from the https route, so neither replaces the other', () => {
    const names = webmailRouteNames('webmail.example.test');
    expect(route.metadata.name).toBe(names.httpIngressName);
    expect(names.httpIngressName).not.toBe(names.ingressName);
  });
});

describe('reconcileWebmailHttpRoutes', () => {
  function db(rows: unknown[]): Database {
    const chain = { from: () => chain, innerJoin: () => chain, where: async () => rows };
    return { select: () => chain } as unknown as Database;
  }
  const k8s = (existing: Array<[string, string]> = []) => ({
    custom: {
      listClusterCustomObject: vi.fn(async () => ({
        items: existing.map(([namespace, name]) => ({ metadata: { namespace, name } })),
      })),
    },
  }) as unknown as K8sClients;

  it('adds the router where the https redirect was published, and only there', async () => {
    const r = await reconcileWebmailHttpRoutes(db([
      { domainName: 'a.test', namespace: 'tenant-a', status: 'ready' },
      { domainName: 'b.test', namespace: 'tenant-b', status: 'ready_no_tls' },
      { domainName: 'c.test', namespace: 'tenant-c', status: 'pending' }, // no Middleware yet
      { domainName: 'd.test', namespace: 'tenant-d', status: 'failed' },
      { domainName: 'platform.test', namespace: 'tenant-system', status: 'ready' }, // the platform's own host
    ]), k8s());
    expect(r).toEqual({ applied: 2, failed: 0 });
    expect(apply.applyIngressRoute.mock.calls.map((c) => (c[1] as { metadata: { namespace: string } }).metadata.namespace))
      .toEqual(['tenant-a', 'tenant-b']);
  });

  it('a settled cluster: one LIST, no apply', async () => {
    const client = k8s([['tenant-a', webmailRouteNames('webmail.a.test').httpIngressName]]);
    const r = await reconcileWebmailHttpRoutes(db([{ domainName: 'a.test', namespace: 'tenant-a', status: 'ready' }]), client);
    expect(r).toEqual({ applied: 0, failed: 0 });
    expect(apply.applyIngressRoute).not.toHaveBeenCalled();
    expect((client.custom.listClusterCustomObject as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      labelSelector: 'app.kubernetes.io/component=webmail,insula.host/entrypoint=web',
    });
  });

  it('a failed apply is counted and left for the next cycle; the others still go through', async () => {
    apply.applyIngressRoute.mockRejectedValueOnce(new Error('admission denied'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await reconcileWebmailHttpRoutes(db([
      { domainName: 'a.test', namespace: 'tenant-a', status: 'ready' },
      { domainName: 'b.test', namespace: 'tenant-b', status: 'ready' },
    ]), k8s());
    expect(r).toEqual({ applied: 1, failed: 1 });
  });
});

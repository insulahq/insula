/**
 * When a tenant serves nothing any more, reconcileIngress removes EVERYTHING it
 * put on the cluster for it.
 *
 * Its "no domains left" and "no routable route left" exits used to delete only
 * the shared IngressRoute. Deleting a tenant's last route (or its domain) left
 * the `<ns>-ingress-http` router behind — seen on DEV after a WAF test site was
 * removed: plain-HTTP requests for a site that no longer existed still got
 * their HTTPS redirect — and with it any mTLS router and TLSOption.
 */
import { describe, it, expect, vi } from 'vitest';
import { reconcileIngress } from './k8s-ingress.js';

const NS = 'tenant-acme';

/** A namespace holding one of each object the reconciler makes. */
function makeK8s() {
  const custom = {
    listNamespacedCustomObject: vi.fn(async (args: { plural: string; labelSelector?: string }) => {
      if (args.plural === 'tlsoptions') return { items: [{ metadata: { name: 'mtls-abcd1234', namespace: NS } }] };
      if (args.plural === 'middlewares') {
        return { items: [{ metadata: { name: 'r-abcd1234-force-https', namespace: NS, labels: { 'app.kubernetes.io/managed-by': 'platform-api', 'hosting-platform/route-id': 'abcd1234' } } }] };
      }
      if (args.plural !== 'ingressroutes') return { items: [] };
      if (args.labelSelector?.includes('mtls=true')) return { items: [{ metadata: { name: `${NS}-ingress-mtls-abcd1234`, namespace: NS } }] };
      if (args.labelSelector?.includes('tls-split')) return { items: [{ metadata: { name: `${NS}-ingress-tls-1234abcd`, namespace: NS } }] };
      return { items: [] };
    }),
    createNamespacedCustomObject: vi.fn(async () => ({})),
    replaceNamespacedCustomObject: vi.fn(async () => ({})),
    deleteNamespacedCustomObject: vi.fn(async () => ({})),
    getNamespacedCustomObject: vi.fn(async () => { throw Object.assign(new Error('nf'), { code: 404, statusCode: 404 }); }),
  };
  return { k8s: { custom, core: {}, apps: {}, networking: {} } as never, custom };
}

/**
 * Reads in order: the tenant's status, its domains, then every other read
 * (routes, deployments, middlewares, site config) answers `rest`.
 */
function makeDb(domainsRows: unknown[], rest: unknown[] = []) {
  let call = 0;
  const select = vi.fn(() => {
    const n = call++;
    const rows = n === 0 ? [{ status: 'active' }] : n === 1 ? domainsRows : rest;
    const builder: Record<string, unknown> = {};
    for (const m of ['from', 'leftJoin', 'innerJoin', 'orderBy', 'limit']) builder[m] = () => builder;
    builder.where = () => Object.assign(Promise.resolve(rows), builder);
    builder.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej);
    return builder;
  });
  return { db: { select } as never };
}

const deleted = (custom: ReturnType<typeof makeK8s>['custom']) =>
  custom.deleteNamespacedCustomObject.mock.calls.map(([a]) => `${(a as { plural: string }).plural}/${(a as { name: string }).name}`);

const EVERYTHING = [
  `ingressroutes/${NS}-ingress`,
  `ingressroutes/${NS}-ingress-http`,
  `ingressroutes/${NS}-ingress-tls-1234abcd`,
  `tlsoptions/mtls-abcd1234`,
  `ingressroutes/${NS}-ingress-mtls-abcd1234`,
  'middlewares/r-abcd1234-force-https',
];

describe('reconcileIngress — a tenant that serves nothing', () => {
  it('its last domain gone: every router goes, the HTTP→HTTPS one included', async () => {
    const { k8s, custom } = makeK8s();
    await reconcileIngress(makeDb([]).db, k8s, 't1', NS);
    expect(deleted(custom)).toEqual(expect.arrayContaining(EVERYTHING));
    // The routers go before the Middlewares they reference.
    const d = deleted(custom);
    expect(d.indexOf(`ingressroutes/${NS}-ingress-http`)).toBeLessThan(d.indexOf('middlewares/r-abcd1234-force-https'));
  });

  it('its last routable route gone (deleted, or left with no target): the same', async () => {
    const { k8s, custom } = makeK8s();
    const domain = { id: 'd1', tenantId: 't1', domainName: 'shop.example.test', deploymentId: null, suppressPublicIngress: false };
    await reconcileIngress(makeDb([domain], []).db, k8s, 't1', NS);
    expect(deleted(custom)).toEqual(expect.arrayContaining(EVERYTHING));
  });
});

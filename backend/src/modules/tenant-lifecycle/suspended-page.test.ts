import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { apexSpy } = vi.hoisted(() => ({ apexSpy: vi.fn(async (): Promise<string | null> => 'example.test') }));
vi.mock('../system-settings/platform-domain.js', () => ({ getPlatformApex: apexSpy }));

import { resolveSuspendedRedirectUrl, repointSuspendedRedirects, reconcileSuspendedPageIngress } from './suspended-page.js';
import { suspendNamespaceIngresses } from './ingress-suspend.js';

const log = { info: vi.fn(), warn: vi.fn() };
const db = {} as never;

describe('resolveSuspendedRedirectUrl', () => {
  afterEach(() => { delete process.env.SUSPENDED_REDIRECT_URL; });

  it('derives the page from the platform apex', async () => {
    expect(await resolveSuspendedRedirectUrl(db)).toBe('https://suspended.example.test/');
  });

  it('never falls back to a placeholder host', async () => {
    apexSpy.mockResolvedValueOnce(null);
    expect(await resolveSuspendedRedirectUrl(db)).toBeNull();
  });

  it('lets the operator override it', async () => {
    process.env.SUSPENDED_REDIRECT_URL = 'https://status.example.test/suspended';
    expect(await resolveSuspendedRedirectUrl(db)).toBe('https://status.example.test/suspended');
  });
});

describe('repointSuspendedRedirects', () => {
  const mw = (namespace: string, name: string, replacement: string) => ({
    metadata: { namespace, name },
    spec: { redirectRegex: { regex: '.*', replacement, permanent: false } },
  });

  function fakeCustom(items: unknown[], failOn?: string) {
    const patched: Array<{ namespace: string; name: string; body: unknown }> = [];
    const custom = {
      listClusterCustomObject: vi.fn(async () => ({ items })),
      patchNamespacedCustomObject: vi.fn(async (args: { namespace: string; name: string; body: unknown }) => {
        if (args.name === failOn) throw new Error('apiserver said no');
        patched.push(args);
      }),
    };
    return { custom: custom as never, patched, list: custom.listClusterCustomObject };
  }

  it('moves every stale redirect to the current page and leaves current ones alone', async () => {
    const url = 'https://suspended.example.test/';
    const { custom, patched, list } = fakeCustom([
      mw('tenant-a', 'r-aaaaaaaa-suspend', 'https://suspended.platform.local/'),
      mw('tenant-b', 'r-bbbbbbbb-suspend', url),
    ]);

    const r = await repointSuspendedRedirects(custom, url, log);

    expect(list).toHaveBeenCalledWith(expect.objectContaining({ labelSelector: 'hosting-platform/suspend=true' }));
    expect(patched).toEqual([
      expect.objectContaining({
        namespace: 'tenant-a',
        name: 'r-aaaaaaaa-suspend',
        body: { spec: { redirectRegex: { replacement: url } } },
      }),
    ]);
    expect(r).toEqual({ scanned: 2, repointed: ['tenant-a/r-aaaaaaaa-suspend'], failed: [] });
  });

  it('reports a middleware it could not patch and carries on', async () => {
    const { custom } = fakeCustom([
      mw('tenant-a', 'r-aaaaaaaa-suspend', 'https://old.example.test/'),
      mw('tenant-b', 'r-bbbbbbbb-suspend', 'https://old.example.test/'),
    ], 'r-aaaaaaaa-suspend');

    const r = await repointSuspendedRedirects(custom, 'https://suspended.example.test/', log);

    expect(r.failed).toEqual(['tenant-a/r-aaaaaaaa-suspend']);
    expect(r.repointed).toEqual(['tenant-b/r-bbbbbbbb-suspend']);
  });
});

describe('reconcileSuspendedPageIngress', () => {
  /** The page's IngressRoute + Certificate as Flux seeded them, plus one
   *  tenant still pointing at the old placeholder. */
  function cluster(opts: { failIngressRoutePatch?: boolean } = {}) {
    const patches: Array<{ plural: string; name: string; body: unknown }> = [];
    const custom = {
      getNamespacedCustomObject: vi.fn(async (a: { plural: string }) => (a.plural === 'ingressroutes'
        ? { metadata: { annotations: {} }, spec: { routes: [{ match: 'Host(`suspended.old.example.test`)', kind: 'Rule' }] } }
        : { metadata: { annotations: {} }, spec: { dnsNames: ['suspended.old.example.test'] } })),
      patchNamespacedCustomObject: vi.fn(async (a: { plural: string; name: string; body: unknown }) => {
        if (opts.failIngressRoutePatch && a.plural === 'ingressroutes') throw new Error('apiserver timeout');
        patches.push(a);
      }),
      listClusterCustomObject: vi.fn(async () => ({
        items: [{ metadata: { namespace: 'tenant-a', name: 'r-aaaaaaaa-suspend' }, spec: { redirectRegex: { replacement: 'https://suspended.platform.local/' } } }],
      })),
    };
    return { custom: custom as never, patches };
  }

  it('moves the page host, its certificate and every suspended tenant to the apex', async () => {
    const { custom, patches } = cluster();

    const r = await reconcileSuspendedPageIngress(db, custom, log);

    expect(r.host).toBe('suspended.example.test');
    expect(JSON.stringify(patches.find((p) => p.plural === 'ingressroutes')?.body)).toContain('Host(`suspended.example.test`)');
    expect(JSON.stringify(patches.find((p) => p.plural === 'certificates')?.body)).toContain('suspended.example.test');
    expect(patches.find((p) => p.plural === 'middlewares')?.body)
      .toEqual({ spec: { redirectRegex: { replacement: 'https://suspended.example.test/' } } });
  });

  it('still re-points tenants when the host patch fails, and does not throw', async () => {
    const { custom, patches } = cluster({ failIngressRoutePatch: true });

    const r = await reconcileSuspendedPageIngress(db, custom, log);

    expect(r.redirects?.repointed).toEqual(['tenant-a/r-aaaaaaaa-suspend']);
    expect(patches.some((p) => p.plural === 'middlewares')).toBe(true);
  });
});

describe('suspendNamespaceIngresses', () => {
  let applied: Array<{ metadata: { name: string }; spec: { redirectRegex: { replacement: string } } }>;
  let replaced: number;

  /** Middlewares do not exist yet (applyMiddleware creates them); the
   *  IngressRoute does. Replaces are counted per kind. */
  function k8sWith(routes: unknown[]) {
    applied = [];
    replaced = 0;
    const notFound = Object.assign(new Error('not found'), { code: 404 });
    return {
      custom: {
        listNamespacedCustomObject: vi.fn(async () => ({ items: routes })),
        getNamespacedCustomObject: vi.fn(async (a: { plural: string }) => {
          if (a.plural === 'middlewares') throw notFound;
          return routes[0];
        }),
        replaceNamespacedCustomObject: vi.fn(async (a: { plural: string }) => {
          if (a.plural === 'ingressroutes') replaced++;
        }),
        createNamespacedCustomObject: vi.fn(async (a: { body: (typeof applied)[number] }) => { applied.push(a.body); }),
      },
    } as never;
  }

  beforeEach(() => { applied = []; replaced = 0; });

  it('sends a newly suspended route to the URL it is given', async () => {
    const k8s = k8sWith([{ metadata: { name: 'site', namespace: 'tenant-a' }, spec: { routes: [{ match: 'Host(`a.example.test`)' }] } }]);

    await suspendNamespaceIngresses(k8s, 'tenant-a', 'https://suspended.example.test/');

    expect(applied.map((m) => m.spec.redirectRegex.replacement)).toEqual(['https://suspended.example.test/']);
    expect(replaced).toBe(1);
  });

  it('re-points an already-suspended route without re-patching it', async () => {
    const k8s = k8sWith([{
      metadata: { name: 'site', namespace: 'tenant-a', annotations: { 'platform.io/suspended': 'true' } },
      spec: { routes: [{ match: 'Host(`a.example.test`)' }] },
    }]);

    const r = await suspendNamespaceIngresses(k8s, 'tenant-a', 'https://suspended.example.test/');

    expect(r.suspended).toEqual(['site']);
    expect(applied.map((m) => m.spec.redirectRegex.replacement)).toEqual(['https://suspended.example.test/']);
    expect(replaced).toBe(0);
  });
});

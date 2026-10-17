/**
 * The per-client concurrency cap must sit directly before `compress` on every
 * compressing route, and running clusters must converge onto it: three of
 * those IngressRoutes are Flux-disowned (`reconcile: disabled`), so the git
 * manifest alone reaches fresh installs only.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DISOWNED_COMPRESS_ROUTES,
  INFLIGHT_MIDDLEWARE,
  reconcileCompressRouteBounds,
  withInflightBeforeCompress,
  type MiddlewareRef,
} from './traefik-compress-bounds.js';
import { reconcileTunnelAnchorMiddlewares } from '../modules/private-workers/anchor-ingress-reconciler.js';

const mw = (name: string, namespace = 'traefik'): MiddlewareRef => ({ name, namespace });
const names = (l: ReadonlyArray<MiddlewareRef>): string[] => l.map((m) => m.name ?? '');

describe('withInflightBeforeCompress', () => {
  it('puts the cap directly before compress', () => {
    expect(names(withInflightBeforeCompress([mw('compress')]).middlewares)).toEqual(['inflight-per-client', 'compress']);
    expect(names(withInflightBeforeCompress([mw('stalwart-jmap-cors', 'mail'), mw('compress')]).middlewares))
      .toEqual(['stalwart-jmap-cors', 'inflight-per-client', 'compress']);
  });

  it('moves a cap that sits elsewhere instead of duplicating it', () => {
    const r = withInflightBeforeCompress([mw('inflight-per-client'), mw('admin-auth-cookie'), mw('compress')]);
    expect(r.changed).toBe(true);
    expect(names(r.middlewares)).toEqual(['admin-auth-cookie', 'inflight-per-client', 'compress']);
  });

  it('leaves a converged list, a list without compress, and a foreign compress alone', () => {
    for (const list of [
      [mw('admin-auth-cookie'), mw('inflight-per-client'), mw('compress')],
      [mw('crowdsec'), mw('tunnel-anchor-ratelimit', 'platform-system')],
      [mw('compress', 'some-tenant')],
    ]) {
      const r = withInflightBeforeCompress(list);
      expect(r.changed).toBe(false);
      expect(r.middlewares).toEqual(list);
    }
  });

  it('does not mutate its input', () => {
    const list = [mw('compress')];
    withInflightBeforeCompress(list);
    expect(list).toEqual([mw('compress')]);
  });
});

/** The three disowned routes exactly as production runs them before this change. */
function legacyRoutes(): Record<string, { metadata: { resourceVersion: string }; spec: { routes: Array<Record<string, unknown>> } }> {
  return {
    'mail/platform-webmail-ingress': {
      metadata: { resourceVersion: '101' },
      spec: { routes: [{ match: 'Host(`webmail.example.test`)', kind: 'Rule', middlewares: [mw('compress')], services: [{ name: 'bulwark', port: 80 }] }] },
    },
    'mail/stalwart-webadmin': {
      metadata: { resourceVersion: '202' },
      spec: {
        routes: [
          { match: 'Host(`stalwart.example.test`) && PathPrefix(`/jmap`)', kind: 'Rule', middlewares: [mw('stalwart-jmap-cors', 'mail'), mw('compress')], services: [{ name: 'stalwart-mgmt', port: 8080 }] },
          { match: 'Host(`stalwart.example.test`)', kind: 'Rule', middlewares: [mw('admin-auth-cookie'), mw('compress')], services: [{ name: 'stalwart-mgmt', port: 8080 }] },
        ],
      },
    },
    'platform-system/tunnel-anchor': {
      metadata: { resourceVersion: '303' },
      spec: {
        routes: [{
          match: 'Host(`tunnels.example.test`)', kind: 'Rule', priority: 1,
          middlewares: [mw('crowdsec'), mw('waf-body-limit'), mw('modsecurity-crs'), mw('tunnel-anchor-ratelimit', 'platform-system'), mw('compress')],
          services: [{ name: 'tunnel-anchor-default', port: 80 }],
        }],
      },
    },
  };
}

function fakeCustom(objects: Record<string, unknown>, failPatch: Set<string> = new Set()) {
  const patches: Array<Record<string, unknown>> = [];
  const api = {
    getNamespacedCustomObject: vi.fn(async (a: { namespace: string; name: string }) => {
      const o = objects[`${a.namespace}/${a.name}`];
      if (!o) throw new Error('404 not found');
      return structuredClone(o);
    }),
    patchNamespacedCustomObject: vi.fn(async (a: { namespace: string; name: string } & Record<string, unknown>, _shim?: unknown) => {
      if (failPatch.has(`${a.namespace}/${a.name}`)) throw new Error('409 Conflict');
      patches.push(a);
    }),
  };
  return { api, patches };
}
const log = { info: vi.fn(), warn: vi.fn() };
type PatchBody = { metadata?: { resourceVersion?: string }; spec: { routes: Array<Record<string, unknown> & { middlewares: MiddlewareRef[] }> } };
const bodyOf = (p: Record<string, unknown>): PatchBody => p.body as PatchBody;

describe('reconcileCompressRouteBounds', () => {
  it('covers exactly the Flux-disowned compressing routes', () => {
    expect(DISOWNED_COMPRESS_ROUTES.map((r) => `${r.namespace}/${r.name}`).sort())
      .toEqual(['mail/platform-webmail-ingress', 'mail/stalwart-webadmin', 'platform-system/tunnel-anchor']);
  });

  it('converges every legacy route, each list with the cap directly before compress', async () => {
    const c = fakeCustom(legacyRoutes());
    const res = await reconcileCompressRouteBounds(c.api as never, log);
    expect(res.patched.sort()).toEqual(['mail/platform-webmail-ingress', 'mail/stalwart-webadmin', 'platform-system/tunnel-anchor']);
    const byName = Object.fromEntries(c.patches.map((p) => [`${p.namespace}/${p.name}`, bodyOf(p)]));
    expect(names(byName['mail/platform-webmail-ingress'].spec.routes[0].middlewares)).toEqual(['inflight-per-client', 'compress']);
    expect(byName['mail/stalwart-webadmin'].spec.routes.map((r) => names(r.middlewares))).toEqual([
      ['stalwart-jmap-cors', 'inflight-per-client', 'compress'],
      ['admin-auth-cookie', 'inflight-per-client', 'compress'],
    ]);
    expect(names(byName['platform-system/tunnel-anchor'].spec.routes[0].middlewares))
      .toEqual(['crowdsec', 'waf-body-limit', 'modsecurity-crs', 'tunnel-anchor-ratelimit', 'inflight-per-client', 'compress']);
    expect(byName['mail/stalwart-webadmin'].spec.routes[0].middlewares[1]).toEqual(INFLIGHT_MIDDLEWARE);
  });

  it('keeps every other route field — MERGE_PATCH replaces the whole routes array', async () => {
    const c = fakeCustom(legacyRoutes());
    await reconcileCompressRouteBounds(c.api as never, log);
    const anchor = bodyOf(c.patches.find((p) => p.name === 'tunnel-anchor')!).spec.routes[0];
    expect(anchor.match).toBe('Host(`tunnels.example.test`)');
    expect(anchor.priority).toBe(1);
    expect(anchor.kind).toBe('Rule');
    expect(anchor.services).toEqual([{ name: 'tunnel-anchor-default', port: 80 }]);
  });

  it('sends the resourceVersion it read, so a concurrent writer is not overwritten', async () => {
    const c = fakeCustom(legacyRoutes());
    await reconcileCompressRouteBounds(c.api as never, log);
    const webmail = c.patches.find((p) => p.name === 'platform-webmail-ingress')!;
    expect(bodyOf(webmail).metadata?.resourceVersion).toBe('101');
  });

  it('sends merge-patch (the client defaults to json-patch and the apiserver rejects an object)', async () => {
    const c = fakeCustom(legacyRoutes());
    await reconcileCompressRouteBounds(c.api as never, log);
    for (const call of c.api.patchNamespacedCustomObject.mock.calls) {
      expect(call.length).toBe(2);
      expect(call[1]).toBeDefined();
    }
  });

  it('is idempotent — converged routes are not patched again', async () => {
    const objects = legacyRoutes();
    const first = fakeCustom(objects);
    await reconcileCompressRouteBounds(first.api as never, log);
    const converged = Object.fromEntries(first.patches.map((p) => [`${p.namespace}/${p.name}`, { spec: bodyOf(p).spec }]));
    const second = fakeCustom(converged);
    const res = await reconcileCompressRouteBounds(second.api as never, log);
    expect(res.patched).toEqual([]);
    expect(second.api.patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('a missing route or a refused patch skips that route, never throws, and still converges the others', async () => {
    const objects = legacyRoutes();
    delete (objects as Record<string, unknown>)['platform-system/tunnel-anchor'];
    const c = fakeCustom(objects, new Set(['mail/stalwart-webadmin']));
    const warn = vi.fn();
    const res = await reconcileCompressRouteBounds(c.api as never, { info: vi.fn(), warn });
    expect(res.patched).toEqual(['mail/platform-webmail-ingress']);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('does not fight the tunnel anchor WAF reconciler: a capped anchor needs no WAF patch', async () => {
    const c = fakeCustom(legacyRoutes());
    await reconcileCompressRouteBounds(c.api as never, log);
    const cappedAnchor = bodyOf(c.patches.find((p) => p.name === 'tunnel-anchor')!).spec.routes;
    const waf = fakeCustom({ 'platform-system/tunnel-anchor': { spec: { routes: cappedAnchor } } });
    await expect(reconcileTunnelAnchorMiddlewares(waf.api as never, log)).resolves.toEqual({ patched: false });
  });
});

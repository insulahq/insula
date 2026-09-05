/**
 * The tunnel anchor must carry the WAF chain, and existing clusters must
 * converge onto it.
 *
 * `tunnels.<apex>` is publicly resolvable with a Let's Encrypt certificate —
 * therefore listed in Certificate Transparency and trivially discoverable by
 * scanners — and until 2026-09-05 its IngressRoute carried a rate limit only:
 * no ModSecurity, no CrowdSec. A banned IP could still reach it.
 *
 * The manifest fix alone is not enough. The anchor carries
 * `kustomize.toolkit.fluxcd.io/reconcile: disabled` (R16 seed-then-disown), so
 * Flux seeds it once and never updates it again — editing the base manifest
 * reaches FRESH INSTALLS ONLY. Every running cluster needs the reconciler.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ANCHOR_WAF_MIDDLEWARES,
  reconcileTunnelAnchorMiddlewares,
} from './anchor-ingress-reconciler.js';

const log = { info: vi.fn(), warn: vi.fn() };

/** The anchor exactly as it shipped before the fix. */
const legacyRoute = {
  match: 'Host(`tunnels.example.test`)',
  kind: 'Rule',
  priority: 1,
  middlewares: [
    { name: 'tunnel-anchor-ratelimit', namespace: 'platform-system' },
    { name: 'compress', namespace: 'traefik' },
  ],
  services: [{ name: 'tunnel-anchor-default', port: 80 }],
};

function fakeCustom(routes: unknown[]) {
  const patches: Array<Record<string, unknown>> = [];
  return {
    patches,
    api: {
      getNamespacedCustomObject: vi.fn(async () => ({ spec: { routes } })),
      patchNamespacedCustomObject: vi.fn(async (arg: Record<string, unknown>, _shim?: unknown) => {
        patches.push(arg);
      }),
    },
  };
}

describe('tunnel anchor WAF middlewares', () => {
  it('prepends the WAF chain to a legacy anchor', async () => {
    const c = fakeCustom([{ ...legacyRoute }]);
    const res = await reconcileTunnelAnchorMiddlewares(c.api as never, log);
    expect(res.patched).toBe(true);
    const body = c.patches[0].body as { spec: { routes: Array<{ middlewares: Array<{ name: string }> }> } };
    expect(body.spec.routes[0].middlewares.map((m) => m.name))
      .toEqual(['crowdsec', 'waf-body-limit', 'modsecurity-crs', 'tunnel-anchor-ratelimit', 'compress']);
  });

  it('keeps the rate limit and compress — the WAF is additive, not a replacement', async () => {
    const c = fakeCustom([{ ...legacyRoute }]);
    await reconcileTunnelAnchorMiddlewares(c.api as never, log);
    const body = c.patches[0].body as { spec: { routes: Array<{ middlewares: Array<{ name: string }> }> } };
    const names = body.spec.routes[0].middlewares.map((m) => m.name);
    expect(names).toContain('tunnel-anchor-ratelimit');
    expect(names).toContain('compress');
  });

  it('preserves every other route field (MERGE_PATCH replaces the whole array)', async () => {
    const c = fakeCustom([{ ...legacyRoute }]);
    await reconcileTunnelAnchorMiddlewares(c.api as never, log);
    const body = c.patches[0].body as { spec: { routes: Array<Record<string, unknown>> } };
    const r = body.spec.routes[0];
    expect(r.match).toBe(legacyRoute.match);
    expect(r.priority).toBe(1);
    expect(r.services).toEqual(legacyRoute.services);
  });

  it('is idempotent — a converged anchor is not patched again', async () => {
    const converged = {
      ...legacyRoute,
      middlewares: [...ANCHOR_WAF_MIDDLEWARES.map((m) => ({ ...m })), ...legacyRoute.middlewares],
    };
    const c = fakeCustom([converged]);
    const res = await reconcileTunnelAnchorMiddlewares(c.api as never, log);
    expect(res.patched).toBe(false);
    expect(c.api.patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('does not duplicate a middleware that is already present', async () => {
    const partial = {
      ...legacyRoute,
      middlewares: [{ name: 'crowdsec', namespace: 'traefik' }, ...legacyRoute.middlewares],
    };
    const c = fakeCustom([partial]);
    await reconcileTunnelAnchorMiddlewares(c.api as never, log);
    const body = c.patches[0].body as { spec: { routes: Array<{ middlewares: Array<{ name: string }> }> } };
    const names = body.spec.routes[0].middlewares.map((m) => m.name);
    expect(names.filter((n) => n === 'crowdsec')).toHaveLength(1);
  });

  it('sends the patch as merge-patch, not json-patch', async () => {
    // @kubernetes/client-node defaults Content-Type to
    // application/json-patch+json whatever the body looks like, so a merge
    // object is rejected by the apiserver with "cannot unmarshal object into
    // Go value of type []handlers.jsonPatchOp". The convergence would have
    // failed at runtime while every unit test here still passed — this test
    // existed and did not catch it; CI's patch guard did.
    const c = fakeCustom([{ ...legacyRoute }]);
    await reconcileTunnelAnchorMiddlewares(c.api as never, log);
    const call = c.api.patchNamespacedCustomObject.mock.calls[0];
    expect(call.length, 'no Content-Type shim passed to patchNamespacedCustomObject').toBe(2);
    expect(call[1]).toBeDefined();
  });

  it('never throws when the anchor is absent (best-effort boot hook)', async () => {
    const api = {
      getNamespacedCustomObject: vi.fn(async () => { throw new Error('404 not found'); }),
      patchNamespacedCustomObject: vi.fn(),
    };
    await expect(reconcileTunnelAnchorMiddlewares(api as never, log)).resolves.toEqual({ patched: false });
    expect(api.patchNamespacedCustomObject).not.toHaveBeenCalled();
  });
});

/**
 * buildAllRouteSpecs builds Middlewares only for routes that are served — the
 * same rule (route-targets.ts isServed) the domains reconciler uses to decide
 * which routes get a router. A switched-off route must get neither.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildAllRouteSpecs } from './annotation-sync.js';

const route = (id: string, over: Record<string, unknown> = {}) => ({
  id, domainId: 'd1', hostname: `${id}.example.test`, path: '/', deploymentId: 'dep-1', privateWorkerId: null,
  redirectUrl: null, servicePort: null, status: 'active', enabled: true, ...over,
});

function dbReturning(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  builder.from = () => builder;
  builder.where = () => Promise.resolve([]);
  builder.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej);
  return { select: vi.fn(() => builder) } as never;
}

describe('buildAllRouteSpecs — which routes it builds', () => {
  it('builds for switched-on routes only, and leaves other tenants\' routes alone', async () => {
    const rows = [
      route('on'),
      route('off', { enabled: false }),
      route('off-redirect', { enabled: false, deploymentId: null, redirectUrl: 'https://elsewhere.example.test/' }),
      route('pending', { status: 'pending' }),
      route('other-tenant', { domainId: 'd2' }),
    ];
    // Returning no backend stops before the per-route build; the resolver
    // sees exactly the routes the builder admitted.
    const resolver = vi.fn(() => null);
    const out = await buildAllRouteSpecs(dbReturning(rows), {} as never, 't1', ['d1'], resolver);
    expect(resolver.mock.calls.map(([r]) => (r as { id: string }).id)).toEqual(['on']);
    expect(out.size).toBe(0);
  });
});

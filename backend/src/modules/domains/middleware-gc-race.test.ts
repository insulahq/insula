import { describe, it, expect, vi } from 'vitest';
import { currentRouteMiddlewareNames } from './k8s-ingress.js';
import type { Database } from '../../db/index.js';

/**
 * Regression guard for issue #611.
 *
 * Two reconciles overlap — a domain create, a route create, a certificate
 * becoming ready and a settings PATCH all trigger one, and nothing serialises
 * them. The older pass reached the Middleware GC holding a keep-set from
 * before the newer route existed and deleted the Middleware the newer pass had
 * just applied. Traefik drops the ENTIRE router for a dangling middleware
 * reference, so the tenant's new hostname answered Traefik's own 404 with
 * every other object present and healthy — until any later edit reconciled it.
 *
 * Observed on DEV on two of three freshly created routes; the third raced the
 * other way and worked, which is what makes it a race rather than a
 * deterministic bug.
 *
 * The fix re-reads the database at GC time. These tests pin what that read
 * must and must not protect.
 */
function mockDb(domainRows: unknown[], routeRows: unknown[]): Database {
  const where = vi.fn().mockResolvedValue(domainRows);
  const from = vi.fn().mockImplementation(() => ({
    where,
    // `select().from(ingressRoutes)` with no where — the route read.
    then: (resolve: (v: unknown) => void) => resolve(routeRows),
  }));
  return { select: vi.fn().mockReturnValue({ from }) } as unknown as Database;
}

const route = (over: Record<string, unknown> = {}) => ({
  id: 'aaaaaaaa-1111-1111-1111-111111111111',
  domainId: 'dom-1',
  hostname: 'a.example.test',
  forceHttps: 1,
  hstsEnabled: 0,
  wwwRedirect: 'none',
  ipAllowlist: null,
  rateLimitRps: null,
  customErrorCodes: null,
  redirectUrl: null,
  ...over,
});

describe('currentRouteMiddlewareNames', () => {
  it('protects a route that exists in the database but was not part of this pass', async () => {
    // Exactly the race: the reconcile running the GC never rendered this route.
    const db = mockDb([{ id: 'dom-1' }], [route()]);
    const names = await currentRouteMiddlewareNames(db, 'tenant-1', 'ns-x');
    expect([...names]).toContain('r-aaaaaaaa-force-https');
  });

  it('still lets a DISABLED setting be swept', async () => {
    // The GC must keep removing middlewares the current settings no longer
    // want — otherwise turning force-HTTPS off would leave it in force.
    const db = mockDb([{ id: 'dom-1' }], [route({ forceHttps: 0 })]);
    const names = await currentRouteMiddlewareNames(db, 'tenant-1', 'ns-x');
    expect([...names]).not.toContain('r-aaaaaaaa-force-https');
  });

  it('ignores routes that belong to another tenant', async () => {
    const db = mockDb([{ id: 'dom-1' }], [route({ domainId: 'someone-elses-domain' })]);
    const names = await currentRouteMiddlewareNames(db, 'tenant-1', 'ns-x');
    expect(names.size).toBe(0);
  });

  it('returns nothing when the tenant has no domains', async () => {
    const db = mockDb([], [route()]);
    const names = await currentRouteMiddlewareNames(db, 'tenant-1', 'ns-x');
    expect(names.size).toBe(0);
  });
});

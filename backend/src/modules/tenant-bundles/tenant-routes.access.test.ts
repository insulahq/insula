/**
 * Every tenant bundle route must scope its query by the caller's tenant.
 *
 * These routes used to carry `requireTenantAccess()` as "defence in depth".
 * It was not depth, it was a fault: the middleware reads
 * `params.tenantId ?? params.id`, and `:id` here is a BUNDLE. It compared a
 * bundle id to the caller's tenant id and returned 403 — so detail, GDPR
 * data-export and export-token were refused to the tenant that owned them,
 * while the list route (no `:id`) worked. Verified on the running cluster:
 * list 200, detail 403.
 *
 * Removing it puts the whole burden on the WHERE clause, which was doing the
 * real work anyway. So the WHERE clause is what this pins: a handler added
 * here that forgets it would leak across tenants with nothing to catch it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('src/modules/tenant-bundles/tenant-routes.ts', 'utf8');

describe('tenant bundle routes are scoped in SQL', () => {
  const routes = [...SRC.matchAll(/app\.(get|post|put|delete)\('(\/tenant\/[^']*)'/g)]
    .map((m) => ({ method: m[1], path: m[2], at: m.index ?? 0 }));

  it('finds the routes it is meant to check', () => {
    // Guards against a rename turning every assertion below into a vacuous
    // pass over an empty list.
    expect(routes.length).toBeGreaterThanOrEqual(4);
  });

  for (const r of routes) {
    it(`${r.method.toUpperCase()} ${r.path} filters by the caller's tenant`, () => {
      // The handler body: up to the next route registration.
      const next = routes.find((o) => o.at > r.at)?.at ?? SRC.length;
      const body = SRC.slice(r.at, next);
      expect(body, `${r.path} does not resolve the tenant from the token`)
        .toMatch(/tenantIdFromRequest\(request\)/);
      expect(body, `${r.path} does not filter the query by tenantId`)
        .toMatch(/eq\(backupJobs\.tenantId,\s*tenantId\)/);
    });
  }

  it('does NOT reinstate requireTenantAccess on this plugin', () => {
    // Re-adding it would 403 every :id route again, and the symptom — a
    // tenant told they cannot access their own backup — reads like a data
    // problem rather than a middleware one.
    expect(SRC).not.toMatch(/addHook\('onRequest',\s*requireTenantAccess\(\)\)/);
  });
});

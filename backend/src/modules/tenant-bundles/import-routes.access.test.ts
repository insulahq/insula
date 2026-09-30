/**
 * Access invariants for the bundle-import routes.
 *
 * Source-level, like `tenant-routes.access.test.ts` — these are properties of
 * how the routes are WIRED, and wiring is exactly what a unit test with a
 * mocked request cannot see. The two that matter:
 *
 *   - a tenant may only import into their own space (no `:tenantId` param)
 *   - the admin routes are role-gated, and `requireRole` is paired with
 *     `authenticate` (alone it 403s everything, because there is no user yet)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { mintImportTarget } from './import-routes.js';

const SRC = readFileSync('src/modules/tenant-bundles/import-routes.ts', 'utf8');
const APP = readFileSync('src/app.ts', 'utf8');

describe('tenant import routes cannot target another tenant', () => {
  const tenantRoutes = [...SRC.matchAll(/app\.(post|get)\('(\/tenant\/[^']*)'/g)].map((m) => m[2]!);

  it('finds the routes it is meant to check', () => {
    expect(tenantRoutes.length).toBeGreaterThanOrEqual(3);
  });

  it('★ no tenant route carries a :tenantId path parameter', () => {
    // A path param is spoofable; the JWT claim is not.
    for (const p of tenantRoutes) expect(p, p).not.toMatch(/:tenantId/);
  });

  it('resolves the tenant from the token', () => {
    expect(SRC).toMatch(/function tenantIdFromRequest/);
    expect(SRC).toMatch(/request\.user\?\.tenantId/);
    // …and fails closed when the claim is absent
    expect(SRC).toMatch(/CLIENT_ACCESS_DENIED/);
  });

  it('gates the tenant plugin on the tenant panel', () => {
    expect(SRC).toMatch(/requirePanel\('tenant'\)/);
  });

  it("passes scope 'tenant' so config and secrets are dropped (ADR-063 D4)", () => {
    // If this ever became 'admin', a tenant could import platform DB rows and
    // TLS private keys asserted by an uploaded file.
    const tenantPlugin = SRC.slice(SRC.indexOf('bundleImportTenantRoutes'));
    expect(tenantPlugin).not.toMatch(/'admin'/);
    expect(tenantPlugin).toMatch(/'tenant'/);
  });
});

describe('admin import routes are role-gated', () => {
  const adminRoutes = [...SRC.matchAll(/app\.post\('(\/admin\/[^']*)'/g)].map((m) => m[1]!);

  it('finds the routes it is meant to check', () => {
    expect(adminRoutes.length).toBeGreaterThanOrEqual(3);
  });

  it('every admin route requires an admin role', () => {
    const count = (SRC.match(/requireRole\('super_admin', 'admin'\)/g) ?? []).length;
    expect(count).toBe(adminRoutes.length);
  });

  it('★ pairs requireRole with authenticate', () => {
    // requireRole on its own 403s everything — there is no request.user to
    // check until authenticate has run.
    const adminPlugin = SRC.slice(SRC.indexOf('export async function bundleImportAdminRoutes'));
    expect(adminPlugin).toMatch(/addHook\('onRequest', authenticate\)/);
  });
});

describe('the import plugins are actually mounted', () => {
  it('both are registered under /api/v1', () => {
    // An unregistered plugin is a 404 that looks like a missing feature.
    expect(APP).toMatch(/register\(bundleImportAdminRoutes, \{ prefix: '\/api\/v1' \}\)/);
    expect(APP).toMatch(/register\(bundleImportTenantRoutes, \{ prefix: '\/api\/v1' \}\)/);
  });
});

describe('the start call re-reads the archive', () => {
  it('★ does not trust a client-supplied unit list', () => {
    // Accepting the preflight back from the client would let a caller import
    // a mailbox whose domain the ownership check never saw.
    const start = SRC.slice(SRC.indexOf('async function startImport'), SRC.indexOf('/** Admin:'));
    expect(start).toMatch(/readArchiveMeta/);
    expect(start).toMatch(/buildImportPreflight/);
    expect(start).toMatch(/preflight\.blocked/);
  });
});

describe('mintImportTarget', () => {
  it('returns an id that survives the id schema and a path under the upload dir', () => {
    const t = mintImportTarget();
    expect(t.importId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(t.uploadDir).toBe('.insula-imports');
    expect(t.uploadPathFor['tar.gz']).toBe(`/.insula-imports/${t.importId}.tar.gz`);
    expect(t.uploadPathFor['tar.gz.enc']).toBe(`/.insula-imports/${t.importId}.tar.gz.enc`);
  });

  it('mints a distinct id each time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => mintImportTarget().importId));
    expect(ids.size).toBe(50);
  });
});

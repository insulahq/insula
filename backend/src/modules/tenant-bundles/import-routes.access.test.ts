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
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Resolved from THIS module, not from the cwd: a relative
// `readFileSync('src/...')` silently fails to load the whole test file when
// vitest is invoked with a different root.
const HERE = dirname(fileURLToPath(import.meta.url));
const srcFile = (name: string): string => readFileSync(join(HERE, name), 'utf8');

import { mintImportTarget } from './import-routes.js';

const SRC = srcFile('import-routes.ts');
const APP = srcFile('../../app.ts');

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

describe('resolveTenantImportTarget', () => {
  // A tenant cannot name a target — they have no way to know which exist, and
  // naming one would be a way to write into a target never granted to them.
  // So the server picks, and ambiguity is an error rather than a guess.
  function stubApp(recent: string | null, writable: string[]) {
    let call = 0;
    return {
      db: {
        select: () => ({
          from: () => {
            call += 1;
            const chain: Record<string, unknown> = {
              where: () => chain,
              orderBy: () => chain,
              limit: () => Promise.resolve(recent ? [{ targetConfigId: recent }] : []),
              then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
                Promise.resolve(call === 2 ? writable.map((id) => ({ id })) : []).then(res, rej),
            };
            return chain;
          },
        }),
      },
    } as never;
  }

  it('keeps a tenant on the target their last bundle already used', async () => {
    const { resolveTenantImportTarget } = await import('./import-routes.js');
    await expect(resolveTenantImportTarget(stubApp('cfg-a', ['cfg-a', 'cfg-b']), 't-1'))
      .resolves.toBe('cfg-a');
  });

  it('★ ignores a remembered target that is no longer writable', async () => {
    // Frozen or deactivated since the last bundle — importing into it would
    // fail deep inside the Job instead of here.
    const { resolveTenantImportTarget } = await import('./import-routes.js');
    await expect(resolveTenantImportTarget(stubApp('cfg-gone', ['cfg-b']), 't-1'))
      .resolves.toBe('cfg-b');
  });

  it('falls back to the only writable target', async () => {
    const { resolveTenantImportTarget } = await import('./import-routes.js');
    await expect(resolveTenantImportTarget(stubApp(null, ['cfg-only']), 't-1'))
      .resolves.toBe('cfg-only');
  });

  it('★ refuses rather than guessing when several targets could apply', async () => {
    const { resolveTenantImportTarget } = await import('./import-routes.js');
    await expect(resolveTenantImportTarget(stubApp(null, ['cfg-a', 'cfg-b']), 't-1'))
      .rejects.toThrow(/several are configured/);
  });

  it('says so when nothing writable is configured', async () => {
    const { resolveTenantImportTarget } = await import('./import-routes.js');
    await expect(resolveTenantImportTarget(stubApp(null, []), 't-1'))
      .rejects.toThrow(/No writable backup target/);
  });
});

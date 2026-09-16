import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { SEARCH_PROVIDERS, type SearchContext, type SearchProvider } from './providers.js';
import { likePattern } from '../../shared/like-pattern.js';
import type { Database } from '../../db/index.js';

/**
 * Global-search providers.
 *
 * The single property that carries real risk: a tenant-panel caller must
 * never receive another tenant's rows. Everything else in this feature is
 * cosmetic by comparison — a missing group is an annoyance, a leaked row
 * is a breach.
 *
 * These tests assert on the SQL the provider BUILDS, not on what a mocked
 * database hands back. A mock that returns `[]` passes every scoping test
 * ever written while the real query selects the whole table; the only
 * honest check is to look at the predicate itself.
 */

const dialect = new PgDialect();

/**
 * A chainable stand-in for `db` that records the `where()` argument and
 * terminates the chain on `limit()`. Providers only ever use this subset
 * (select → from → leftJoin* → where → orderBy → limit), so a provider
 * that reaches for anything else fails loudly here rather than silently
 * skipping the assertion.
 */
function recordingDb(rows: unknown[] = []) {
  const captured: { where?: SQL | undefined; called: boolean } = { called: false };
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    select: self,
    from: self,
    leftJoin: self,
    orderBy: self,
    where: (w: SQL | undefined) => {
      captured.where = w;
      captured.called = true;
      return chain;
    },
    limit: () => Promise.resolve(rows),
  });
  return { db: chain as unknown as Database, captured };
}

/** Render a built predicate to the SQL text Postgres would actually receive. */
function renderWhere(where: SQL | undefined): string {
  if (!where) return '';
  const query = dialect.sqlToQuery(where);
  // Inline the params so a `tenant_id = $1` predicate is still checkable
  // against the id we passed in.
  return query.params.reduce<string>(
    (text, param, i) => text.replace(`$${i + 1}`, String(param)),
    query.sql,
  );
}

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

function tenantCtx(tenantId = TENANT_A): SearchContext {
  return { panel: 'tenant', role: 'tenant_admin', tenantId };
}
function adminCtx(role: SearchContext['role'] = 'super_admin'): SearchContext {
  return { panel: 'admin', role };
}

const tenantCapable = SEARCH_PROVIDERS.filter((p) => p.panels.includes('tenant'));
const adminCapable = SEARCH_PROVIDERS.filter((p) => p.panels.includes('admin'));
/** Reachable from the tenant panel AND owning per-tenant rows — the risky set. */
const tenantScoped = tenantCapable.filter((p) => p.scope === 'tenant');

describe('tenant scoping', () => {
  it('has tenant-scoped providers to check (guards against an empty-set pass)', () => {
    // `[].every(...)` is true and `it.each([])` runs nothing. If a refactor
    // renamed `panels`/`scope` or emptied the registry, every assertion below
    // would pass by vacuity — so pin the set size before asserting on it.
    expect(tenantScoped.length).toBeGreaterThanOrEqual(7);
  });

  it('pins which tenant-panel providers are allowed to skip tenant filtering', () => {
    // A 'platform' provider on the tenant panel returns the same rows to every
    // tenant. That is correct for the shared application catalog and wrong for
    // anything a tenant owns, so the set is pinned by name: adding to it is a
    // deliberate edit here, reviewed alongside the provider itself, rather
    // than a silent consequence of a new `scope: 'platform'` somewhere.
    const unscoped = tenantCapable.filter((p) => p.scope === 'platform').map((p) => p.type).sort();
    expect(unscoped).toEqual(['catalog_entry']);
  });

  it.each(tenantScoped.map((p) => [p.type, p] as const))(
    '%s scopes every tenant-panel query to the caller\'s tenantId',
    async (_type, provider: SearchProvider) => {
      const { db, captured } = recordingDb();
      await provider.run(db, tenantCtx(), 'anything', 5);

      expect(captured.called).toBe(true);
      const sql = renderWhere(captured.where);
      expect(sql).toContain('tenant_id');
      expect(sql).toContain(TENANT_A);
      // And must not somehow carry a different tenant's id.
      expect(sql).not.toContain(TENANT_B);
    },
  );

  it.each(tenantScoped.map((p) => [p.type, p] as const))(
    '%s refuses to run for a tenant context with no tenantId',
    async (_type, provider: SearchProvider) => {
      const { db } = recordingDb();
      const broken = { panel: 'tenant', role: 'tenant_admin' } as SearchContext;
      // Fail closed: an unscoped tenant query would return the whole estate,
      // so a malformed token must throw rather than fall through to a
      // predicate-free SELECT.
      await expect(provider.run(db, broken, 'anything', 5)).rejects.toThrow(/tenantId/);
    },
  );

  it('admin-only providers are never offered to the tenant panel', () => {
    const adminOnly = SEARCH_PROVIDERS.filter((p) => !p.panels.includes('tenant'));
    expect(adminOnly.map((p) => p.type)).toContain('tenant');
    expect(adminOnly.map((p) => p.type)).toContain('node');
    for (const p of adminOnly) {
      expect(p.roles.some((r) => r === 'tenant_admin' || r === 'tenant_user')).toBe(false);
    }
  });

  it('admin queries carry no tenant predicate', async () => {
    const provider = adminCapable.find((p) => p.type === 'domain');
    expect(provider).toBeDefined();
    const { db, captured } = recordingDb();
    await provider!.run(db, adminCtx(), 'example', 5);
    expect(renderWhere(captured.where)).not.toContain('tenant_id');
  });
});

describe('search term handling', () => {
  it('escapes LIKE wildcards so `_` is not a match-everything query', () => {
    // `_` is LIKE's single-character wildcard. Unescaped, typing it returns
    // the entire table and reads as "search is broken".
    expect(likePattern('_')).toBe('%\\_%');
    expect(likePattern('%')).toBe('%\\%%');
    expect(likePattern('a_b%c')).toBe('%a\\_b\\%c%');
  });

  it('escapes backslashes before the wildcards, not after', () => {
    // Wrong order turns `\` into `\\` and then mangles the next escape.
    expect(likePattern('\\')).toBe('%\\\\%');
    expect(likePattern('\\_')).toBe('%\\\\\\_%');
  });

  it('leaves ordinary terms alone', () => {
    expect(likePattern('acme')).toBe('%acme%');
    expect(likePattern('mail.example.test')).toBe('%mail.example.test%');
  });

  it('matches case-insensitively via ILIKE, not LIKE', async () => {
    // Postgres LIKE is case-SENSITIVE, so `like(name, '%acme%')` never finds
    // "Acme Ltd". Every user-facing name search in the palette must be ilike.
    const provider = SEARCH_PROVIDERS.find((p) => p.type === 'tenant');
    const { db, captured } = recordingDb();
    await provider!.run(db, adminCtx(), 'acme', 5);
    const sql = renderWhere(captured.where).toLowerCase();
    expect(sql).toContain('ilike');
  });
});

describe('provider registry shape', () => {
  it('declares a unique type per provider', () => {
    const types = SEARCH_PROVIDERS.map((p) => p.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it('gives every provider at least one panel and one role', () => {
    for (const p of SEARCH_PROVIDERS) {
      expect(p.panels.length, `${p.type} has no panels`).toBeGreaterThan(0);
      expect(p.roles.length, `${p.type} has no roles`).toBeGreaterThan(0);
      expect(p.label.length, `${p.type} has no label`).toBeGreaterThan(0);
    }
  });

  it('never grants a tenant role to a provider that cannot be tenant-scoped', () => {
    // A provider reachable by a tenant role MUST also be listed for the
    // tenant panel, or the role grant is meaningless at best and a leak at
    // worst if someone later adds the panel without revisiting scoping.
    for (const p of SEARCH_PROVIDERS) {
      const hasTenantRole = p.roles.some((r) => r === 'tenant_admin' || r === 'tenant_user');
      if (hasTenantRole) {
        expect(p.panels, `${p.type} grants a tenant role`).toContain('tenant');
      }
    }
  });
});

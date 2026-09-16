import { describe, it, expect, vi } from 'vitest';
import { providersFor, runSearch } from './service.js';
import { SEARCH_PROVIDERS, type SearchContext, type SearchProvider } from './providers.js';
import type { Database } from '../../db/index.js';
import type { SearchItem } from '@insula/api-contracts';

/**
 * Provider selection and result assembly.
 *
 * `GET /api/v1/search` carries no requireRole gate — every authenticated
 * user hits the same URL. That makes provider selection the ONLY thing
 * standing between a read_only admin and the user directory, so it is
 * worth testing at least as hard as the SQL.
 */

const db = {} as Database;

function ctx(over: Partial<SearchContext> = {}): SearchContext {
  return { panel: 'admin', role: 'super_admin', ...over };
}

const typesFor = (c: SearchContext) => providersFor(c).map((p) => p.type).sort();

describe('providersFor', () => {
  it('gives a super_admin the full admin set', () => {
    const types = typesFor(ctx({ role: 'super_admin' }));
    expect(types).toContain('tenant');
    expect(types).toContain('user');
    expect(types).toContain('node');
    expect(types).toContain('hosting_plan');
  });

  it('withholds the user directory from read_only and support', () => {
    // Mirrors admin-users/routes.ts, which gates the directory on
    // super_admin/admin only. If the palette listed users for `support`,
    // search would be a way around a role boundary the API already draws.
    expect(typesFor(ctx({ role: 'read_only' }))).not.toContain('user');
    expect(typesFor(ctx({ role: 'support' }))).not.toContain('user');
  });

  it('withholds cluster nodes from read_only and support', () => {
    // nodes/routes.ts gates the whole plugin on super_admin/admin.
    expect(typesFor(ctx({ role: 'read_only' }))).not.toContain('node');
    expect(typesFor(ctx({ role: 'support' }))).not.toContain('node');
  });

  it('still lets read_only find tenants, domains and mailboxes', () => {
    // read_only is a real working role, not a null role — the palette would
    // be pointless for them if the gate were simply "admin or nothing".
    const types = typesFor(ctx({ role: 'read_only' }));
    expect(types).toContain('tenant');
    expect(types).toContain('domain');
    expect(types).toContain('mailbox');
  });

  it('never hands a tenant caller an admin-only provider', () => {
    const types = typesFor(ctx({ panel: 'tenant', role: 'tenant_admin', tenantId: 't1' }));
    expect(types).not.toContain('tenant');
    expect(types).not.toContain('node');
    expect(types).not.toContain('user');
    expect(types).not.toContain('hosting_plan');
    expect(types).not.toContain('backup_target');
  });

  it('gives tenant_user the same read surface as tenant_admin', () => {
    // Search is read-only, so the two tenant roles see the same rows. The
    // write boundary between them lives on the mutating endpoints.
    expect(typesFor(ctx({ panel: 'tenant', role: 'tenant_admin', tenantId: 't1' })))
      .toEqual(typesFor(ctx({ panel: 'tenant', role: 'tenant_user', tenantId: 't1' })));
  });

  it('requires BOTH panel and role to match, not either', () => {
    // A tenant role on the admin panel (a malformed token) must select
    // nothing rather than falling through to the admin set.
    expect(typesFor(ctx({ panel: 'admin', role: 'tenant_user' }))).toEqual([]);
  });

  it('selects nothing for a role no provider lists', () => {
    expect(typesFor(ctx({ role: 'billing' }))).toEqual([]);
  });
});

// ─── runSearch ───────────────────────────────────────────────────────────────

function item(id: string): SearchItem {
  return { id, type: 'tenant', title: id, subtitle: null, href: `/x/${id}`, badge: null };
}

function fakeProvider(over: Partial<SearchProvider> & { type: SearchItem['type'] }): SearchProvider {
  return {
    label: 'Fake',
    panels: ['admin'],
    scope: 'platform',
    roles: ['super_admin'],
    run: async () => [],
    ...over,
  } as SearchProvider;
}

/** Swap the module-level registry for a fixture set, restoring afterwards. */
async function withProviders<T>(fixtures: SearchProvider[], fn: () => Promise<T>): Promise<T> {
  const original = [...SEARCH_PROVIDERS];
  const target = SEARCH_PROVIDERS as unknown as SearchProvider[];
  target.length = 0;
  target.push(...fixtures);
  try {
    return await fn();
  } finally {
    target.length = 0;
    target.push(...original);
  }
}

describe('runSearch', () => {
  it('drops empty groups instead of rendering empty headings', async () => {
    const result = await withProviders(
      [
        fakeProvider({ type: 'tenant', run: async () => [item('a')] }),
        fakeProvider({ type: 'domain', run: async () => [] }),
      ],
      () => runSearch(db, ctx(), 'q'),
    );
    expect(result.groups.map((g) => g.type)).toEqual(['tenant']);
  });

  it('caps a group at the limit and flags it truncated', async () => {
    // The provider is asked for limit+1 so "there is more" is a fact about
    // the data, not a guess from a full page.
    const many = ['1', '2', '3', '4', '5', '6'].map(item);
    const result = await withProviders(
      [fakeProvider({ type: 'tenant', run: async () => many })],
      () => runSearch(db, ctx(), 'q'),
    );
    expect(result.groups[0]?.items).toHaveLength(5);
    expect(result.groups[0]?.truncated).toBe(true);
  });

  it('does not flag truncated when the group exactly fills the cap', async () => {
    const exactly = ['1', '2', '3', '4', '5'].map(item);
    const result = await withProviders(
      [fakeProvider({ type: 'tenant', run: async () => exactly })],
      () => runSearch(db, ctx(), 'q'),
    );
    expect(result.groups[0]?.items).toHaveLength(5);
    expect(result.groups[0]?.truncated).toBe(false);
  });

  it('keeps every other group when one provider throws', async () => {
    // One broken query against one table is not a reason to blank the
    // dropdown. The failure is reported separately so the caller can tell
    // "this group failed" from "this group had no matches" — silently
    // returning an empty group would turn an outage into "nothing here".
    const log = { warn: vi.fn() };
    const result = await withProviders(
      [
        fakeProvider({ type: 'tenant', run: async () => [item('a')] }),
        fakeProvider({ type: 'domain', run: async () => { throw new Error('relation does not exist'); } }),
        fakeProvider({ type: 'mailbox', run: async () => [item('b')] }),
      ],
      () => runSearch(db, ctx(), 'q', log),
    );
    expect(result.groups.map((g) => g.type)).toEqual(['tenant', 'mailbox']);
    expect(result.failed).toEqual(['domain']);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('bounds the logged failure reason so a search term cannot be dumped whole', async () => {
    // A driver error can carry the failing statement, and the statement
    // contains whatever the user typed.
    const log = { warn: vi.fn() };
    await withProviders(
      [fakeProvider({ type: 'tenant', run: async () => { throw new Error('x'.repeat(5000)); } })],
      () => runSearch(db, ctx(), 'q', log),
    );
    const logged = JSON.stringify(log.warn.mock.calls[0]?.[0] ?? {});
    expect(logged.length).toBeLessThan(400);
  });

  it('preserves registration order in the output', async () => {
    const result = await withProviders(
      [
        fakeProvider({ type: 'tenant', run: async () => [item('a')] }),
        fakeProvider({ type: 'domain', run: async () => [item('b')] }),
        fakeProvider({ type: 'mailbox', run: async () => [item('c')] }),
      ],
      () => runSearch(db, ctx(), 'q'),
    );
    expect(result.groups.map((g) => g.type)).toEqual(['tenant', 'domain', 'mailbox']);
  });

  it('runs no provider at all for a role with no grants', async () => {
    const spy = vi.fn(async () => [item('a')]);
    const result = await withProviders(
      [fakeProvider({ type: 'tenant', roles: ['super_admin'], run: spy })],
      () => runSearch(db, ctx({ role: 'billing' }), 'q'),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(result.groups).toEqual([]);
  });
});

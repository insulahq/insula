/**
 * A bundle's config dump is a `SELECT *` of the tables as they were when it
 * was taken; upsertRow writes each row by its own keys. A column the platform
 * has retired must not be written, or every bundle taken before the column is
 * dropped fails to restore after it ("column … does not exist").
 */
import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { RETIRED_BUNDLE_COLUMNS, upsertRow } from './_shared.js';

async function render(sqlTable: string, row: Record<string, unknown>): Promise<{ sql: string; params: unknown[] }> {
  const seen: SQL[] = [];
  await upsertRow({ execute: async (q) => { seen.push(q as SQL); return undefined; } }, sqlTable, row);
  expect(seen).toHaveLength(1);
  return new PgDialect().sqlToQuery(seen[0]);
}

describe('upsertRow and retired columns', () => {
  it('drops a retired users column from a bundle taken before it was retired', async () => {
    const q = await render('users', {
      id: 'u-1', email: 'owner@example.test', full_name: 'Owner', timezone: 'Europe/Berlin',
    });
    expect(q.sql).not.toContain('"timezone"');
    expect(q.params).not.toContain('Europe/Berlin');
    expect(q.sql).toContain('"email"');
    expect(q.params).toEqual(expect.arrayContaining(['u-1', 'owner@example.test', 'Owner']));
  });

  it('keeps a same-named column on another table', async () => {
    // tenants.timezone is live: it becomes the TZ of the tenant's containers.
    const q = await render('tenants', { id: 't-1', name: 'Acme', timezone: 'Europe/Berlin' });
    expect(q.sql).toContain('"timezone"');
    expect(q.params).toContain('Europe/Berlin');
  });

  it('lists users.timezone as retired', () => {
    expect(RETIRED_BUNDLE_COLUMNS.users).toContain('timezone');
  });

  it('drops the per-domain spam thresholds from an email_domains row', async () => {
    // The mail server never applied them; its threshold is server-wide.
    const q = await render('email_domains', {
      id: 'ed-1', tenant_id: 't-1', catch_all_address: null, spam_threshold_junk: '5.0', spam_threshold_reject: '10.0',
    });
    expect(q.sql).not.toContain('"spam_threshold_junk"');
    expect(q.sql).not.toContain('"spam_threshold_reject"');
    expect(q.sql).toContain('"catch_all_address"');
  });
});

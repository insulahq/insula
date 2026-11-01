/**
 * Keyset pagination under any sort, on real Postgres: paging through a list
 * in pages of 2 must yield exactly the rows of one full ORDER BY — no row
 * skipped, none repeated — with ties, NULLs and timestamps a microsecond apart.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, sql, type SQL } from 'drizzle-orm';
import { boolean, integer, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { closeTestDb, getTestDb, isDbAvailable } from '../test-helpers/db.js';
import {
  encodeListCursor,
  listCursorCondition,
  listOrderBy,
  listSortKeySelect,
  resolveListSort,
  type ListSort,
  type SortFields,
} from './list-sort.js';

const dbAvailable = await isDbAvailable();

const probe = pgTable('list_sort_probe', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: text('name'),
  n: integer('n'),
  at: timestamp('at'),
  on: boolean('on'),
});

const FIELDS: SortFields = {
  name: { expr: probe.name, kind: 'text' },
  n: { expr: probe.n, kind: 'numeric' },
  at: { expr: probe.at, kind: 'timestamp' },
  on: { expr: probe.on, kind: 'boolean' },
};

describe.skipIf(!dbAvailable)('list-sort keyset pagination (integration)', () => {
  const db = () => getTestDb();

  beforeAll(async () => {
    await db().execute(sql`DROP TABLE IF EXISTS list_sort_probe`);
    await db().execute(sql`CREATE TABLE list_sort_probe (id varchar(36) PRIMARY KEY, name text, n integer, at timestamp, "on" boolean)`);
    // Ties on every key, NULLs on every key, mixed case, and three timestamps
    // in the same millisecond.
    await db().execute(sql`INSERT INTO list_sort_probe VALUES
      ('a1', 'alpha', 3, '2026-10-31 10:00:00.000001', true),
      ('a2', 'Alpha', 3, '2026-10-31 10:00:00.000002', true),
      ('a3', 'beta',  1, '2026-10-31 10:00:00.000003', false),
      ('a4', NULL,    NULL, NULL, NULL),
      ('a5', 'gamma', 2, '2026-10-31 09:00:00', false),
      ('a6', 'beta',  2, '2026-10-31 11:00:00', NULL),
      ('a7', NULL,    5, '2026-10-31 10:00:00.000002', true)`);
  });
  afterAll(async () => {
    await db().execute(sql`DROP TABLE IF EXISTS list_sort_probe`);
    await closeTestDb();
  });

  const fullOrder = async (sort: ListSort) => (await db()
    .select({ id: probe.id })
    .from(probe)
    .orderBy(...listOrderBy(sort, FIELDS, probe.id))).map((r) => r.id);

  const paged = async (sort: ListSort, pageSize: number) => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const cond: SQL | undefined = listCursorCondition(cursor, 'probe', sort, FIELDS, probe.id);
      const rows = await db()
        .select({ id: probe.id, sortKey: listSortKeySelect(sort, FIELDS) })
        .from(probe)
        .where(cond ? and(cond) : undefined)
        .orderBy(...listOrderBy(sort, FIELDS, probe.id))
        .limit(pageSize + 1);
      const data = rows.slice(0, pageSize);
      seen.push(...data.map((r) => r.id));
      if (rows.length <= pageSize) return seen;
      cursor = encodeListCursor('probe', sort, data[data.length - 1]);
    }
    throw new Error('did not finish');
  };

  for (const field of Object.keys(FIELDS)) {
    for (const direction of ['asc', 'desc'] as const) {
      it(`pages by ${field} ${direction} exactly like one full ORDER BY`, async () => {
        const sort = { field, direction };
        const full = await fullOrder(sort);
        expect(full).toHaveLength(7);
        expect(await paged(sort, 2)).toEqual(full);
        expect(await paged(sort, 1)).toEqual(full);
      });
    }
  }

  it('sorts text case-insensitively and puts NULLs last in both directions', async () => {
    const asc = await fullOrder({ field: 'name', direction: 'asc' });
    expect(asc.slice(0, 2).sort()).toEqual(['a1', 'a2']); // alpha / Alpha together
    expect(asc.slice(-2).sort()).toEqual(['a4', 'a7']);
    const desc = await fullOrder({ field: 'name', direction: 'desc' });
    expect(desc.slice(-2).sort()).toEqual(['a4', 'a7']);
  });

  it('refuses a tampered cursor with 400 INVALID_CURSOR before any SQL runs', async () => {
    const { encodeCursor } = await import('./pagination.js');
    const forged = (sortJson: string, id = 'a1') => encodeCursor({ resource: 'probe', sort: sortJson, id });
    const at = { field: 'at', direction: 'asc' } as const;
    for (const cursor of [
      forged('null'),
      forged('"just a string"'),
      forged(JSON.stringify({ f: 'at', d: 'asc', v: 'not a timestamp' })),
      forged(JSON.stringify({ f: 'at', d: 'asc', v: 42 })),
      forged(JSON.stringify({ f: 'at', d: 'asc', v: '2026-10-31 10:00:00' }), "a1' OR '1'='1"),
    ]) {
      expect(() => listCursorCondition(cursor, 'probe', at, FIELDS, probe.id)).toThrow(/invalid|different sort/i);
    }
    // A well-formed one still works.
    expect(listCursorCondition(forged(JSON.stringify({ f: 'at', d: 'asc', v: '2026-10-31 10:00:00.000002' })), 'probe', at, FIELDS, probe.id)).toBeDefined();
  });

  it('refuses a field the endpoint does not allow, and a cursor from another sort', async () => {
    expect(() => resolveListSort('password:asc', FIELDS, { field: 'name', direction: 'asc' })).toThrow(/Cannot sort by 'password'/);
    expect(resolveListSort(undefined, FIELDS, { field: 'name', direction: 'asc' })).toEqual({ field: 'name', direction: 'asc' });
    expect(resolveListSort('n:desc', FIELDS, { field: 'name', direction: 'asc' })).toEqual({ field: 'n', direction: 'desc' });
    const cursor = encodeListCursor('probe', { field: 'name', direction: 'asc' }, { id: 'a1', sortKey: 'alpha' });
    expect(() => listCursorCondition(cursor, 'probe', { field: 'n', direction: 'asc' }, FIELDS, probe.id)).toThrow(/different sort/);
  });
});

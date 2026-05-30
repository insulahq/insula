/**
 * Regression test for the duplicate-CIDR → 409 mapping in createRange().
 *
 * The bug: a duplicate insert surfaces as a Drizzle `DrizzleQueryError`
 * whose top-level `.message` is "Failed query: insert into …" — it does
 * NOT contain "duplicate key"/"unique". The original guard matched only
 * the top-level message, so the duplicate escaped as a generic error
 * and the route returned 500 instead of 409 DUPLICATE_CIDR. The real
 * node-postgres error (`.code === '23505'`, "duplicate key value
 * violates unique constraint") lives on `err.cause`.
 *
 * createRange must detect the violation by walking the cause chain and
 * checking the SQLSTATE code OR the message text at every level.
 */
import { describe, it, expect } from 'vitest';
import { createRange } from './service.js';
import type { Database } from '../../db/index.js';

/** A db whose .insert(...).values(...).returning() rejects with `err`. */
function insertRejectsDb(err: unknown): Database {
  const chain = {
    values() {
      return { returning() { return Promise.reject(err); } };
    },
  };
  return { insert() { return chain; } } as unknown as Database;
}

const INPUT = {
  cidr: '203.0.113.0/24',
  description: 'x',
  source: 'operator' as const,
  createdBy: null,
};

describe('createRange duplicate detection', () => {
  it('maps a Drizzle-wrapped unique violation (cause.code 23505) to DUPLICATE_CIDR', async () => {
    // Shape mirrors what node-postgres + Drizzle actually throw: the
    // outer message says "Failed query: …" and the SQLSTATE is on cause.
    const pgErr: any = new Error('duplicate key value violates unique constraint "cluster_trusted_proxy_ranges_cidr_idx"');
    pgErr.code = '23505';
    const drizzleErr: any = new Error('Failed query: insert into "cluster_trusted_proxy_ranges" ...');
    drizzleErr.name = 'DrizzleQueryError';
    drizzleErr.cause = pgErr;

    await expect(createRange(insertRejectsDb(drizzleErr), INPUT)).rejects.toMatchObject({
      code: 'DUPLICATE_CIDR',
    });
  });

  it('maps a direct .code 23505 (no wrapper) to DUPLICATE_CIDR', async () => {
    const err: any = new Error('Failed query: insert into ...');
    err.code = '23505';
    await expect(createRange(insertRejectsDb(err), INPUT)).rejects.toMatchObject({
      code: 'DUPLICATE_CIDR',
    });
  });

  it('maps a cause whose only signal is the message text', async () => {
    const cause: any = new Error('duplicate key value violates unique constraint');
    const outer: any = new Error('Failed query: insert into ...');
    outer.cause = cause;
    await expect(createRange(insertRejectsDb(outer), INPUT)).rejects.toMatchObject({
      code: 'DUPLICATE_CIDR',
    });
  });

  it('re-throws a non-unique DB error unchanged (not masked as DUPLICATE)', async () => {
    const cause: any = new Error('connection reset by peer');
    cause.code = '08006';
    const outer: any = new Error('Failed query: insert into ...');
    outer.cause = cause;
    await expect(createRange(insertRejectsDb(outer), INPUT)).rejects.not.toMatchObject({
      code: 'DUPLICATE_CIDR',
    });
    await expect(createRange(insertRejectsDb(outer), INPUT)).rejects.toThrow(/Failed query|connection reset/);
  });
});

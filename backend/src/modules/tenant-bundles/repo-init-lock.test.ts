import { describe, it, expect, vi } from 'vitest';
import { makeRepoInitSerialiser } from './repo-init-lock.js';
import type { Database } from '../../db/index.js';

/**
 * Two components sharing one per-tenant repository must not both run
 * `restic init`: that leaves the repo with two master keys and a config sealed
 * by only one of them, which fails every later run permanently.
 *
 * What matters here is not "a lock is taken" but the three behaviours a
 * fail-open lock must get right: it must not run the initialiser twice, it
 * must not swallow the initialiser's own failure, and it must not block a
 * backup when the database is unavailable.
 */

type Executed = { sql: string };

function fakeDb(opts: {
  onExecute?: (index: number) => void;
  commitError?: Error;
} = {}): { db: Database; executed: Executed[] } {
  const executed: Executed[] = [];
  const db = {
    transaction: async (cb: (tx: unknown) => Promise<void>): Promise<void> => {
      const tx = {
        execute: async (q: unknown): Promise<void> => {
          // drizzle SQL objects carry their chunks; stringify enough to assert on.
          executed.push({ sql: JSON.stringify(q) });
          opts.onExecute?.(executed.length - 1);
        },
      };
      await cb(tx);
      if (opts.commitError) throw opts.commitError;
    },
  } as unknown as Database;
  return { db, executed };
}

describe('makeRepoInitSerialiser', () => {
  it('runs the initialiser exactly once, under a transaction', async () => {
    const { db, executed } = fakeDb();
    const run = vi.fn(async () => 'initialised');
    const serialise = makeRepoInitSerialiser(db);

    await expect(serialise('s3:http://shim/tenant/restic/t1', run)).resolves.toBe('initialised');

    expect(run).toHaveBeenCalledTimes(1);
    // lock_timeout, then the advisory lock itself.
    expect(executed).toHaveLength(2);
    expect(executed[0].sql).toContain('lock_timeout');
    expect(executed[1].sql).toContain('pg_advisory_xact_lock');
  });

  it('keys the lock on the repo URI, so two layouts do not block each other', async () => {
    const { db, executed } = fakeDb();
    const serialise = makeRepoInitSerialiser(db);
    await serialise('s3:http://shim/tenant/restic/t1', async () => undefined);
    await serialise('s3:http://shim/tenant/restic-files/t1', async () => undefined);

    const keys = executed.filter((e) => e.sql.includes('pg_advisory_xact_lock'));
    expect(keys).toHaveLength(2);
    expect(keys[0].sql).toContain('restic-init:s3:http://shim/tenant/restic/t1');
    expect(keys[1].sql).toContain('restic-init:s3:http://shim/tenant/restic-files/t1');
    expect(keys[0].sql).not.toEqual(keys[1].sql);
  });

  it('propagates the initialiser\'s own failure WITHOUT re-running it', async () => {
    // The fail-open path must not turn a genuine init failure into a second
    // init attempt — that is how you get two keys in the repo.
    const { db } = fakeDb();
    const boom = new Error('restic init exited 1: Fatal: wrong password');
    const run = vi.fn(async () => {
      throw boom;
    });

    await expect(makeRepoInitSerialiser(db)('repo', run)).rejects.toThrow('wrong password');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('falls open and still initialises when the lock cannot be taken', async () => {
    // A backup that refuses to start because Postgres is unreachable is worse
    // than an unserialised init.
    const { db } = fakeDb({
      onExecute: (i) => {
        if (i === 1) throw new Error('canceling statement due to lock timeout');
      },
    });
    const run = vi.fn(async () => 'ok');
    const warn = vi.fn();

    await expect(makeRepoInitSerialiser(db, { warn })('repo', run)).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('lock timeout');
  });

  it('falls open when the transaction cannot even start', async () => {
    const db = {
      transaction: async () => {
        throw new Error('ECONNREFUSED 10.43.0.9:5432');
      },
    } as unknown as Database;
    const run = vi.fn(async () => 'ok');

    await expect(makeRepoInitSerialiser(db)('repo', run)).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('returns the value when the initialiser succeeded but the commit did not', async () => {
    // The repo IS initialised at that point; failing the component over an
    // empty transaction's commit would be a false negative.
    const { db } = fakeDb({ commitError: new Error('connection terminated unexpectedly') });
    const run = vi.fn(async () => 'initialised');

    await expect(makeRepoInitSerialiser(db)('repo', run)).resolves.toBe('initialised');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

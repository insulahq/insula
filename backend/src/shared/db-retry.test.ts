import { describe, it, expect, vi } from 'vitest';
import { isTransientDbError, withDbRetry } from './db-retry.js';

// Drizzle wraps the driver error: DrizzleQueryError("Failed query: …", { cause }).
const wrapped = (cause: unknown) => Object.assign(new Error('Failed query: UPDATE mail_migration_runs …'), { cause });
const pgErr = (code: string, message = 'x') => Object.assign(new Error(message), { code });

describe('isTransientDbError', () => {
  it.each([
    ['connection refused (rw Service has no endpoint mid-failover)', wrapped(Object.assign(new Error('connect ECONNREFUSED 10.43.0.9:5432'), { code: 'ECONNREFUSED' }))],
    ['admin shutdown of the old primary (57P01)', wrapped(pgErr('57P01', 'terminating connection due to administrator command'))],
    ['connection failure class 08', wrapped(pgErr('08006'))],
    ['a demoted primary refusing writes (25006)', wrapped(pgErr('25006', 'cannot execute UPDATE in a read-only transaction'))],
    ['the pool losing its socket', wrapped(new Error('Connection terminated unexpectedly'))],
    ['the server still starting', wrapped(pgErr('57P03', 'the database system is starting up'))],
  ])('%s → transient', (_l, err) => {
    expect(isTransientDbError(err)).toBe(true);
  });

  it.each([
    ['a constraint violation', wrapped(pgErr('23505', 'duplicate key value'))],
    ['a SQL error', wrapped(pgErr('42703', 'column "intent" does not exist'))],
    ['a plain programming error', new TypeError('x is not a function')],
    ['a non-error value', 'nope'],
  ])('%s → NOT transient (retrying would only delay the real failure)', (_l, err) => {
    expect(isTransientDbError(err)).toBe(false);
  });
});

describe('withDbRetry', () => {
  const noSleep = async () => undefined;

  it('retries a transient failure until the database answers', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(wrapped(pgErr('57P01')))
      .mockRejectedValueOnce(wrapped(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })))
      .mockResolvedValue('ok');
    const onRetry = vi.fn();
    await expect(withDbRetry(fn, { sleep: noSleep, onRetry })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('a non-transient error is thrown at once', async () => {
    const fn = vi.fn().mockRejectedValue(wrapped(pgErr('23505')));
    await expect(withDbRetry(fn, { sleep: noSleep })).rejects.toThrow('Failed query');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt budget with the last error', async () => {
    const fn = vi.fn().mockRejectedValue(wrapped(pgErr('57P01')));
    await expect(withDbRetry(fn, { attempts: 4, sleep: noSleep })).rejects.toThrow('Failed query');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('the default budget outlasts a CNPG failover (≥ 90 s of retries)', async () => {
    const slept: number[] = [];
    const fn = vi.fn().mockRejectedValue(wrapped(pgErr('57P01')));
    await expect(withDbRetry(fn, { sleep: async (ms) => { slept.push(ms); } })).rejects.toThrow();
    expect(slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(90_000);
  });
});

/**
 * The `/internal/mail/*` bearer gate had NO test coverage while it used a
 * `!==` string compare. It is the only thing standing between an in-cluster
 * caller and endpoints that write operator-visible mail state, so it gets
 * tests now that it has been rewritten.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertInternalBearer, safeSecretEqual, INTERNAL_BEARER_ROUTE } from './internal-bearer.js';
import { ApiError } from '../../shared/errors.js';

const SECRET = 'super-secret-internal-value-0123456789';

describe('safeSecretEqual', () => {
  it('accepts an exact match', () => {
    expect(safeSecretEqual(SECRET, SECRET)).toBe(true);
  });

  it('rejects a different value of the same length', () => {
    const other = SECRET.slice(0, -1) + 'X';
    expect(other).toHaveLength(SECRET.length);
    expect(safeSecretEqual(other, SECRET)).toBe(false);
  });

  it('rejects a prefix without throwing', () => {
    // The pre-hash is what makes this safe: timingSafeEqual on raw buffers
    // throws on a length mismatch, and that throw leaks the expected length.
    expect(() => safeSecretEqual(SECRET.slice(0, 5), SECRET)).not.toThrow();
    expect(safeSecretEqual(SECRET.slice(0, 5), SECRET)).toBe(false);
  });

  it('rejects a value that merely starts with the secret', () => {
    expect(safeSecretEqual(SECRET + 'extra', SECRET)).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(safeSecretEqual('', SECRET)).toBe(false);
  });
});

describe('assertInternalBearer', () => {
  const saved = {
    secret: process.env.PLATFORM_INTERNAL_SECRET,
    token: process.env.PLATFORM_INTERNAL_TOKEN,
  };

  beforeEach(() => {
    delete process.env.PLATFORM_INTERNAL_SECRET;
    delete process.env.PLATFORM_INTERNAL_TOKEN;
  });

  afterEach(() => {
    if (saved.secret === undefined) delete process.env.PLATFORM_INTERNAL_SECRET;
    else process.env.PLATFORM_INTERNAL_SECRET = saved.secret;
    if (saved.token === undefined) delete process.env.PLATFORM_INTERNAL_TOKEN;
    else process.env.PLATFORM_INTERNAL_TOKEN = saved.token;
  });

  it('fails CLOSED with 503 when no secret is configured', () => {
    // The dangerous bug would be treating "unset" as "no check required".
    expect(() => assertInternalBearer({ authorization: 'Bearer anything' }))
      .toThrowError(expect.objectContaining({
        status: 503,
        code: 'INTERNAL_TOKEN_NOT_CONFIGURED',
      }) as unknown as ApiError);
  });

  it('accepts the correct bearer token', () => {
    process.env.PLATFORM_INTERNAL_SECRET = SECRET;
    expect(() => assertInternalBearer({ authorization: `Bearer ${SECRET}` })).not.toThrow();
  });

  it('accepts PLATFORM_INTERNAL_TOKEN as the legacy name', () => {
    process.env.PLATFORM_INTERNAL_TOKEN = SECRET;
    expect(() => assertInternalBearer({ authorization: `Bearer ${SECRET}` })).not.toThrow();
  });

  it('prefers PLATFORM_INTERNAL_SECRET when both are set', () => {
    process.env.PLATFORM_INTERNAL_SECRET = SECRET;
    process.env.PLATFORM_INTERNAL_TOKEN = 'the-other-one';
    expect(() => assertInternalBearer({ authorization: `Bearer ${SECRET}` })).not.toThrow();
    expect(() => assertInternalBearer({ authorization: 'Bearer the-other-one' })).toThrow();
  });

  it('rejects a wrong token with 401', () => {
    process.env.PLATFORM_INTERNAL_SECRET = SECRET;
    expect(() => assertInternalBearer({ authorization: 'Bearer wrong' }))
      .toThrowError(expect.objectContaining({
        status: 401,
        code: 'UNAUTHORIZED',
      }) as unknown as ApiError);
  });

  it('rejects a missing Authorization header', () => {
    process.env.PLATFORM_INTERNAL_SECRET = SECRET;
    expect(() => assertInternalBearer({})).toThrow();
  });

  it('rejects the raw secret without the Bearer prefix', () => {
    process.env.PLATFORM_INTERNAL_SECRET = SECRET;
    expect(() => assertInternalBearer({ authorization: SECRET })).toThrow();
  });

  it('rejects a non-Bearer scheme carrying the secret', () => {
    process.env.PLATFORM_INTERNAL_SECRET = SECRET;
    expect(() => assertInternalBearer({ authorization: `Basic ${SECRET}` })).toThrow();
  });

  it('uses the first value when the header arrives as an array', () => {
    process.env.PLATFORM_INTERNAL_SECRET = SECRET;
    expect(() => assertInternalBearer({ authorization: [`Bearer ${SECRET}`, 'Bearer junk'] }))
      .not.toThrow();
    expect(() => assertInternalBearer({ authorization: ['Bearer junk', `Bearer ${SECRET}`] }))
      .toThrow();
  });
});

describe('INTERNAL_BEARER_ROUTE', () => {
  it('skips the plugin-wide user auth hooks', () => {
    // Without skipAuth the plugin's `authenticate` hook runs first, fails to
    // verify the internal token as a JWT, and the handler never executes.
    expect(INTERNAL_BEARER_ROUTE.config.skipAuth).toBe(true);
  });

  it('opts out of the global rate limiter', () => {
    // The limiter keys on `user.sub ?? request.ip`; these callers have no JWT,
    // so every node on the cluster would share ONE 100/min bucket and the
    // 5-minute standby-replicate reports would throttle themselves away.
    expect(INTERNAL_BEARER_ROUTE.config.rateLimit).toBe(false);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import {
  readStalwartMasterUser,
  _resetCacheForTests,
  MASTER_USER_FALLBACK,
  MASTER_SENTINEL_DOMAIN,
  MASTER_USER_DEFAULT,
  CACHE_TTL_MS,
  type ReadStalwartMasterUserDeps,
} from './stalwart-master-user.js';

beforeEach(() => {
  _resetCacheForTests();
});

describe('readStalwartMasterUser', () => {
  it('returns the value from mail-secrets when present', async () => {
    const deps: ReadStalwartMasterUserDeps = {
      readSecret: async (ns, name, key) => {
        expect(ns).toBe('mail');
        expect(name).toBe('mail-secrets');
        expect(key).toBe('STALWART_MASTER_USER');
        return 'master@staging.example.test';
      },
    };
    expect(await readStalwartMasterUser(null, deps)).toBe('master@staging.example.test');
  });

  it('trims whitespace from the secret value', async () => {
    const deps: ReadStalwartMasterUserDeps = {
      readSecret: async () => '  master@apex.example.com  \n',
    };
    expect(await readStalwartMasterUser(null, deps)).toBe('master@apex.example.com');
  });

  it('falls back to compiled-in default when Secret is missing the key', async () => {
    const deps: ReadStalwartMasterUserDeps = {
      readSecret: async () => null,
    };
    expect(await readStalwartMasterUser(null, deps)).toBe(MASTER_USER_FALLBACK);
  });

  it('falls back to compiled-in default when key is empty/whitespace-only', async () => {
    const deps: ReadStalwartMasterUserDeps = {
      readSecret: async () => '   \n  ',
    };
    expect(await readStalwartMasterUser(null, deps)).toBe(MASTER_USER_FALLBACK);
  });

  it('falls back to compiled-in default when no k8s client AND no readSecret override', async () => {
    expect(await readStalwartMasterUser(null)).toBe(MASTER_USER_FALLBACK);
  });

  it('returns the cached value while within TTL, even with a different reader', async () => {
    let calls = 0;
    const goodDeps: ReadStalwartMasterUserDeps = {
      readSecret: async () => { calls += 1; return 'master@apex.example.com'; },
    };
    const first = await readStalwartMasterUser(null, goodDeps);
    expect(first).toBe('master@apex.example.com');
    expect(calls).toBe(1);

    // A second read inside TTL must NOT call the underlying reader.
    const badDeps: ReadStalwartMasterUserDeps = {
      readSecret: async () => { throw new Error('should not be called'); },
    };
    const second = await readStalwartMasterUser(null, badDeps);
    expect(second).toBe('master@apex.example.com');
  });

  it('honours the last good cached value when a fresh read fails (past TTL)', async () => {
    // Prime cache.
    await readStalwartMasterUser(null, { readSecret: async () => 'master@old.example.com' });
    // Advance past TTL.
    const tNow = Date.now() + CACHE_TTL_MS + 1;
    const result = await readStalwartMasterUser(null, {
      readSecret: async () => { throw new Error('k8s API down'); },
      nowMs: () => tNow,
    });
    expect(result).toBe('master@old.example.com');
  });

  it('falls back to default when cache is unprimed AND the reader throws', async () => {
    const deps: ReadStalwartMasterUserDeps = {
      readSecret: async () => { throw new Error('forbidden'); },
    };
    expect(await readStalwartMasterUser(null, deps)).toBe(MASTER_USER_FALLBACK);
  });

  it('refreshes the cache after TTL on next successful read', async () => {
    await readStalwartMasterUser(null, { readSecret: async () => 'master@a.example.com' });
    const tNow = Date.now() + CACHE_TTL_MS + 1;
    const refreshed = await readStalwartMasterUser(null, {
      readSecret: async () => 'master@b.example.com',
      nowMs: () => tNow,
    });
    expect(refreshed).toBe('master@b.example.com');
  });
});

describe('master sentinel constants (mail-domain-independent master, 2026-06-25)', () => {
  it('pins the master to the fixed local.host sentinel (a valid non-.local TLD)', () => {
    expect(MASTER_SENTINEL_DOMAIN).toBe('local.host');
    expect(MASTER_USER_DEFAULT).toBe('master@local.host');
    // The sentinel must NOT be the rejected .local pseudo-TLD that broke auth.
    expect(MASTER_SENTINEL_DOMAIN.endsWith('.local')).toBe(false);
  });

  it('makes the compiled-in fallback equal the canonical sentinel FQDN', () => {
    // Pre-2026-06-25 the fallback was the broken master@master.local; it is now
    // a VALID auth Domain, so degrading to it self-heals instead of breaking.
    expect(MASTER_USER_FALLBACK).toBe(MASTER_USER_DEFAULT);
    expect(MASTER_USER_FALLBACK).toBe('master@local.host');
  });
});

import { describe, it, expect } from 'vitest';
import type { Database } from '../../db/index.js';
import { findCrossAccountOverlap, normalizeDomainName, parentDomainNames } from './overlap.js';

// A database that must not be reached: the platform-apex answers come from
// the name alone.
const unreachableDb = new Proxy({}, {
  get() { throw new Error('the database should not be queried'); },
}) as unknown as Database;

describe('normalizeDomainName', () => {
  it('lowercases, trims and drops trailing dots', () => {
    expect(normalizeDomainName('  Shop.EXAMPLE.test.. ')).toBe('shop.example.test');
  });
});

describe('parentDomainNames', () => {
  it('lists every enclosing name of two labels or more, nearest first', () => {
    expect(parentDomainNames('a.b.example.test')).toEqual(['b.example.test', 'example.test']);
  });

  it('never offers a bare TLD as a parent', () => {
    expect(parentDomainNames('example.test')).toEqual([]);
  });

  it('compares case-insensitively', () => {
    expect(parentDomainNames('WWW.Example.Test')).toEqual(['example.test']);
  });
});

describe('findCrossAccountOverlap — the platform apex', () => {
  it('a name under the apex is inside the platform\'s own domain', async () => {
    await expect(findCrossAccountOverlap(unreachableDb, 't1', 'Login.Platform.Example.test', 'platform.example.test'))
      .resolves.toEqual({ relation: 'inside', platform: true });
  });

  it('a name the apex sits under contains the platform\'s own domain', async () => {
    await expect(findCrossAccountOverlap(unreachableDb, 't1', 'example.test', 'platform.example.test'))
      .resolves.toEqual({ relation: 'contains', platform: true });
  });

  it('a name that merely ends in the apex\'s letters is not under it', async () => {
    // `notplatform.example.test` shares a suffix string with
    // `platform.example.test` but is not a subdomain of it, so the answer has
    // to come from the database (which this stub refuses).
    await expect(findCrossAccountOverlap(unreachableDb, 't1', 'notplatform.example.test', 'platform.example.test'))
      .rejects.toThrow('should not be queried');
  });
});

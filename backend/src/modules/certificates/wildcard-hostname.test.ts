/**
 * Tests for the shared wildcard-hostname semantics.
 *
 * The helpers live in `@insula/api-contracts` (both panels need the same
 * validation), but the tests live here because backend/vitest is the only
 * runner CI actually executes over that package — `packages/api-contracts`
 * has no test script, so a spec placed next to the source would never run.
 */

import { describe, it, expect } from 'vitest';
import {
  certCoversHostname,
  certDnsNamesForHostname,
  isAtOrUnder,
  isWildcardHostname,
  labelCount,
  longestMatchingDomain,
  normalizeHostname,
  relativeRecordName,
  sanCoversHostname,
  validateRouteHostname,
  wildcardBase,
  wildcardMatchesHostname,
} from '@insula/api-contracts';

describe('normalizeHostname', () => {
  it('lowercases and strips exactly one trailing dot', () => {
    expect(normalizeHostname('WWW.Example.Test.')).toBe('www.example.test');
    expect(normalizeHostname('  www.example.test  ')).toBe('www.example.test');
  });
});

describe('isWildcardHostname / wildcardBase', () => {
  it('recognises wildcards at any depth', () => {
    expect(isWildcardHostname('*.example.test')).toBe(true);
    expect(isWildcardHostname('*.a.example.test')).toBe(true);
    expect(wildcardBase('*.a.example.test')).toBe('a.example.test');
  });

  it('rejects a bare star and partial labels', () => {
    expect(isWildcardHostname('*')).toBe(false);
    expect(isWildcardHostname('*.')).toBe(false);
    expect(isWildcardHostname('www.example.test')).toBe(false);
    expect(wildcardBase('www.example.test')).toBeNull();
  });

  it('counts the star as a label', () => {
    expect(labelCount('*.a.example.test')).toBe(4);
    expect(labelCount('example.test')).toBe(2);
  });
});

describe('isAtOrUnder', () => {
  it('is suffix-safe', () => {
    expect(isAtOrUnder('example.test', 'example.test')).toBe(true);
    expect(isAtOrUnder('a.example.test', 'example.test')).toBe(true);
    // The bug this guards: naive endsWith() accepts a sibling name.
    expect(isAtOrUnder('notexample.test', 'example.test')).toBe(false);
  });
});

describe('relativeRecordName', () => {
  it('maps hostnames onto zone-relative record names', () => {
    expect(relativeRecordName('example.test', 'example.test')).toBe('@');
    expect(relativeRecordName('www.example.test', 'example.test')).toBe('www');
    expect(relativeRecordName('*.example.test', 'example.test')).toBe('*');
    expect(relativeRecordName('*.a.example.test', 'example.test')).toBe('*.a');
  });

  it('does not rewrite a repeated suffix in the middle of the name', () => {
    // `String.replace('.example.test','')` would produce 'a' here.
    expect(relativeRecordName('a.example.test.example.test', 'example.test')).toBe(
      'a.example.test',
    );
  });
});

describe('validateRouteHostname', () => {
  it('accepts the apex, subdomains and wildcards at any depth', () => {
    for (const host of [
      'example.test',
      'www.example.test',
      'a.b.example.test',
      '*.example.test',
      '*.a.example.test',
    ]) {
      const result = validateRouteHostname(host, 'example.test');
      expect(result.ok, `${host} should be accepted: ${result.error}`).toBe(true);
      expect(result.hostname).toBe(host);
    }
  });

  it('normalises case and trailing dots', () => {
    expect(validateRouteHostname('WWW.Example.Test.', 'example.test').hostname).toBe(
      'www.example.test',
    );
  });

  it('rejects a hostname outside the domain', () => {
    const result = validateRouteHostname('www.other.test', 'example.test');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('must be');
  });

  it('rejects a sibling domain that merely shares a suffix', () => {
    expect(validateRouteHostname('notexample.test', 'example.test').ok).toBe(false);
  });

  it('rejects a wildcard that reaches above the domain', () => {
    // Authority is checked on the wildcard's parent: `example.test` is
    // above the registered domain `a.example.test`.
    const result = validateRouteHostname('*.example.test', 'a.example.test');
    expect(result.ok).toBe(false);
  });

  it('rejects wildcards that are not a whole leading label', () => {
    expect(validateRouteHostname('*x.example.test', 'example.test').ok).toBe(false);
    expect(validateRouteHostname('www.*.example.test', 'example.test').ok).toBe(false);
    expect(validateRouteHostname('a.*.b.example.test', 'example.test').ok).toBe(false);
  });

  it('rejects invalid labels and over-long names', () => {
    expect(validateRouteHostname('under_score.example.test', 'example.test').ok).toBe(false);
    expect(validateRouteHostname('-lead.example.test', 'example.test').ok).toBe(false);
    expect(validateRouteHostname('', 'example.test').ok).toBe(false);
    const long = `${'a'.repeat(60)}.`.repeat(5) + 'example.test';
    expect(validateRouteHostname(long, 'example.test').ok).toBe(false);
  });
});

describe('sanCoversHostname', () => {
  it('matches exactly and one label deep', () => {
    expect(sanCoversHostname('www.example.test', 'www.example.test')).toBe(true);
    expect(sanCoversHostname('*.example.test', 'www.example.test')).toBe(true);
  });

  it('does not match deeper names or the parent itself', () => {
    expect(sanCoversHostname('*.example.test', 'a.b.example.test')).toBe(false);
    expect(sanCoversHostname('*.example.test', 'example.test')).toBe(false);
  });

  it('only an identical wildcard SAN covers a wildcard hostname', () => {
    expect(sanCoversHostname('*.a.example.test', '*.a.example.test')).toBe(true);
    expect(sanCoversHostname('*.example.test', '*.a.example.test')).toBe(false);
  });

  it('is suffix-safe', () => {
    expect(sanCoversHostname('*.example.test', 'www.notexample.test')).toBe(false);
  });
});

describe('certCoversHostname / certDnsNamesForHostname', () => {
  it('requests the wildcard together with its parent', () => {
    expect(certDnsNamesForHostname('*.a.example.test')).toEqual([
      '*.a.example.test',
      'a.example.test',
    ]);
    expect(certDnsNamesForHostname('www.example.test')).toEqual(['www.example.test']);
  });

  it('a domain-level wildcard cert covers the apex and one level down only', () => {
    const sans = certDnsNamesForHostname('*.example.test');
    expect(certCoversHostname('example.test', sans)).toBe(true);
    expect(certCoversHostname('www.example.test', sans)).toBe(true);
    expect(certCoversHostname('x.a.example.test', sans)).toBe(false);
  });

  it('a sub-subdomain wildcard cert covers its own level', () => {
    const sans = certDnsNamesForHostname('*.a.example.test');
    expect(certCoversHostname('x.a.example.test', sans)).toBe(true);
    expect(certCoversHostname('a.example.test', sans)).toBe(true);
    expect(certCoversHostname('x.y.a.example.test', sans)).toBe(false);
  });
});

describe('wildcardMatchesHostname', () => {
  it('behaves like the routing rule it generates', () => {
    expect(wildcardMatchesHostname('*.example.test', 'shop.example.test')).toBe(true);
    expect(wildcardMatchesHostname('*.example.test', 'deep.shop.example.test')).toBe(false);
    expect(wildcardMatchesHostname('shop.example.test', 'shop.example.test')).toBe(true);
  });
});

describe('longestMatchingDomain', () => {
  const domains = [
    { domainName: 'example.test', id: 'apex' },
    { domainName: 'a.example.test', id: 'child' },
  ];

  it('picks the most specific registered domain', () => {
    expect(longestMatchingDomain('x.a.example.test', domains)?.id).toBe('child');
    expect(longestMatchingDomain('x.example.test', domains)?.id).toBe('apex');
  });

  it('resolves a wildcard through its parent', () => {
    expect(longestMatchingDomain('*.a.example.test', domains)?.id).toBe('child');
    expect(longestMatchingDomain('*.example.test', domains)?.id).toBe('apex');
  });

  it('returns null when nothing matches', () => {
    expect(longestMatchingDomain('other.test', domains)).toBeNull();
  });
});

/**
 * Wildcard coverage of the reserved-hostname set.
 *
 * The pre-wildcard check was a Set membership test, which a wildcard
 * route walks straight past: `*.example.test` is not in the set, yet it
 * answers for every name in it.
 */

import { describe, it, expect } from 'vitest';
import { matchReservedHostnames } from './reserved-subdomains.js';
import type { ReservedHostnames } from './reserved-subdomains.js';

const reserved: ReservedHostnames = {
  apex: 'example.test',
  fqdns: new Set(['example.test', 'admin.example.test', 'mail.example.test']),
  reasons: new Map([
    ['example.test', 'platform apex'],
    ['admin.example.test', 'platform admin UI'],
    ['mail.example.test', 'platform mail host'],
  ]),
};

describe('matchReservedHostnames', () => {
  it('flags an exact reserved hostname', () => {
    expect(matchReservedHostnames(reserved, 'admin.example.test')).toEqual([
      ['admin.example.test', 'platform admin UI'],
    ]);
  });

  it('flags every reserved name a wildcard would answer for', () => {
    const hits = matchReservedHostnames(reserved, '*.example.test');
    expect(hits.map(([fqdn]) => fqdn)).toEqual([
      'admin.example.test',
      'mail.example.test',
    ]);
    // The apex itself is NOT covered by `*.example.test` (RFC 6125).
    expect(hits.map(([fqdn]) => fqdn)).not.toContain('example.test');
  });

  it('does not flag a tenant hostname or a tenant wildcard', () => {
    expect(matchReservedHostnames(reserved, 'shop.acme.test')).toEqual([]);
    expect(matchReservedHostnames(reserved, '*.acme.test')).toEqual([]);
  });

  it('does not flag a deeper wildcard that cannot reach the reserved level', () => {
    // `*.a.example.test` matches x.a.example.test — never admin.example.test.
    expect(matchReservedHostnames(reserved, '*.a.example.test')).toEqual([]);
  });

  it('normalises case and trailing dots', () => {
    expect(matchReservedHostnames(reserved, 'ADMIN.Example.Test.')).toHaveLength(1);
  });
});

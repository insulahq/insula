import { describe, it, expect } from 'vitest';
import { normalizeNsHostnames, assertUniqueServerNameInGroup } from './validation.js';
import { ApiError } from '../../shared/errors.js';

describe('normalizeNsHostnames', () => {
  it('returns an empty list for null/undefined/empty input', () => {
    expect(normalizeNsHostnames(null)).toEqual([]);
    expect(normalizeNsHostnames(undefined)).toEqual([]);
    expect(normalizeNsHostnames([])).toEqual([]);
  });

  it('trims entries and drops blanks', () => {
    expect(normalizeNsHostnames(['  ns1.example.test  ', '', '   ', 'ns2.example.test'])).toEqual([
      'ns1.example.test',
      'ns2.example.test',
    ]);
  });

  it('accepts a normal two-nameserver group', () => {
    expect(normalizeNsHostnames(['ns1.example.test', 'ns2.example.test'])).toEqual([
      'ns1.example.test',
      'ns2.example.test',
    ]);
  });

  // The regression this whole validator exists for: a group holding the same
  // hostname twice makes PowerDNS reject the apex NS RRset with 422, so zone
  // creation silently leaves placeholder NS records behind.
  it('rejects an exact duplicate', () => {
    expect(() => normalizeNsHostnames(['ns1.example.test', 'ns1.example.test'])).toThrow(ApiError);
    try {
      normalizeNsHostnames(['ns1.example.test', 'ns1.example.test']);
    } catch (err) {
      expect((err as ApiError).code).toBe('DUPLICATE_NS_HOSTNAME');
      expect((err as ApiError).status).toBe(400);
    }
  });

  it('treats case and a trailing root dot as the same host', () => {
    expect(() => normalizeNsHostnames(['ns1.example.test', 'NS1.Example.Test.'])).toThrow(ApiError);
  });

  it('names every duplicate in the message', () => {
    try {
      normalizeNsHostnames(['a.example.test', 'a.example.test', 'b.example.test', 'b.example.test']);
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as ApiError).message).toContain('a.example.test');
      expect((err as ApiError).message).toContain('b.example.test');
    }
  });
});

describe('assertUniqueServerNameInGroup', () => {
  const servers = [
    { id: 's1', displayName: 'Primary NS', groupId: 'g1' },
    { id: 's2', displayName: 'Secondary NS', groupId: 'g1' },
    { id: 's3', displayName: 'Primary NS', groupId: 'g2' },
  ];

  it('allows a distinct name in the group', () => {
    expect(() => assertUniqueServerNameInGroup(servers, 'Tertiary NS', 'g1')).not.toThrow();
  });

  it('rejects a duplicate name within the same group', () => {
    expect(() => assertUniqueServerNameInGroup(servers, 'Primary NS', 'g1')).toThrow(ApiError);
    try {
      assertUniqueServerNameInGroup(servers, 'Primary NS', 'g1');
    } catch (err) {
      expect((err as ApiError).code).toBe('DUPLICATE_DNS_SERVER_NAME');
      expect((err as ApiError).status).toBe(409);
    }
  });

  it('compares case-insensitively and ignores surrounding whitespace', () => {
    expect(() => assertUniqueServerNameInGroup(servers, '  primary ns ', 'g1')).toThrow(ApiError);
  });

  it('allows the same name in a DIFFERENT group', () => {
    expect(() => assertUniqueServerNameInGroup(servers, 'Secondary NS', 'g2')).not.toThrow();
  });

  it('lets a server keep its own name on update', () => {
    expect(() => assertUniqueServerNameInGroup(servers, 'Primary NS', 'g1', 's1')).not.toThrow();
  });

  it('still blocks renaming onto a sibling', () => {
    expect(() => assertUniqueServerNameInGroup(servers, 'Secondary NS', 'g1', 's1')).toThrow(ApiError);
  });

  it('does not constrain ungrouped servers', () => {
    expect(() => assertUniqueServerNameInGroup(servers, 'Primary NS', null)).not.toThrow();
    expect(() => assertUniqueServerNameInGroup(servers, 'Primary NS', undefined)).not.toThrow();
  });
});

import { describe, it, expect } from 'vitest';
import { fqdn, qualifyName, formatContent, splitContent } from './wire-format.js';

/**
 * Every expectation here was checked against a real PowerDNS 4.9 API.
 *
 * The tests these replace passed content that was ALREADY in wire format
 * (`content: 'mail.example.com.'`, `priority: 10`) — a shape no caller
 * produces. That fixture hid the fact that MX records had never once been
 * accepted by PowerDNS: the panel sends a bare hostname, and the platform's
 * own mail provisioning sent a bare hostname plus a priority, which the
 * server rejected with `Not in expected format`.
 */
describe('formatContent', () => {
  describe('MX', () => {
    it('canonicalises the target — a non-canonical MX target is rejected by PowerDNS', () => {
      expect(formatContent({ type: 'MX', name: '@', content: 'mail.example.test', priority: 10 }))
        .toBe('10 mail.example.test.');
    });

    it('refuses an MX with no priority instead of emitting a bare hostname', () => {
      expect(() => formatContent({ type: 'MX', name: '@', content: 'mail.example.test' }))
        .toThrow(/require a priority/i);
    });

    it('passes through content that already carries its priority (pulled from the provider)', () => {
      expect(formatContent({ type: 'MX', name: '@', content: '10 mail.example.test.' }))
        .toBe('10 mail.example.test.');
    });

    it('does not double-prefix when both a formatted value and a priority column exist', () => {
      expect(formatContent({ type: 'MX', name: '@', content: '20 mail.example.test.', priority: 10 }))
        .toBe('20 mail.example.test.');
    });
  });

  describe('SRV', () => {
    it('composes priority, weight and port into the content', () => {
      expect(formatContent({
        type: 'SRV', name: '_sip._tcp', content: 'sip.example.test',
        priority: 10, weight: 5, port: 5060,
      })).toBe('10 5 5060 sip.example.test.');
    });

    it.each(['weight', 'port'] as const)('refuses an SRV missing %s', (missing) => {
      const input = { type: 'SRV', name: '_sip._tcp', content: 'sip.example.test', priority: 10, weight: 5, port: 5060 };
      delete (input as Record<string, unknown>)[missing];
      expect(() => formatContent(input)).toThrow(/priority, weight and port/i);
    });

    it('passes through already-composed SRV content', () => {
      expect(formatContent({ type: 'SRV', name: '_sip._tcp', content: '10 5 5060 sip.example.test.' }))
        .toBe('10 5 5060 sip.example.test.');
    });
  });

  describe('CAA', () => {
    it('quotes the value', () => {
      expect(formatContent({ type: 'CAA', name: '@', content: '0 issue letsencrypt.org' }))
        .toBe('0 issue "letsencrypt.org"');
    });

    it('leaves an already-quoted value alone', () => {
      expect(formatContent({ type: 'CAA', name: '@', content: '0 issue "letsencrypt.org"' }))
        .toBe('0 issue "letsencrypt.org"');
    });

    it('refuses a bare hostname', () => {
      expect(() => formatContent({ type: 'CAA', name: '@', content: 'letsencrypt.org' }))
        .toThrow(/flags.*tag.*value/i);
    });
  });

  describe('hostname-valued types', () => {
    it.each(['CNAME', 'NS', 'PTR', 'DNAME', 'ALIAS'])('canonicalises %s targets', (type) => {
      expect(formatContent({ type, name: 'x', content: 'target.example.test' }))
        .toBe('target.example.test.');
    });

    it('leaves an already-canonical target alone', () => {
      expect(formatContent({ type: 'CNAME', name: 'x', content: 'target.example.test.' }))
        .toBe('target.example.test.');
    });
  });

  describe('TXT', () => {
    it('quotes unquoted content', () => {
      expect(formatContent({ type: 'TXT', name: '@', content: 'v=spf1 mx ~all' }))
        .toBe('"v=spf1 mx ~all"');
    });

    it('does not double-quote', () => {
      expect(formatContent({ type: 'TXT', name: '@', content: '"v=spf1 mx ~all"' }))
        .toBe('"v=spf1 mx ~all"');
    });
  });

  it('leaves address records untouched', () => {
    expect(formatContent({ type: 'A', name: '@', content: '203.0.113.10' })).toBe('203.0.113.10');
    expect(formatContent({ type: 'AAAA', name: '@', content: '2001:db8::1' })).toBe('2001:db8::1');
  });
});

describe('qualifyName', () => {
  const ZONE = 'example.test';

  it.each([
    ['@', 'example.test.'],
    ['', 'example.test.'],
    ['www', 'www.example.test.'],
    ['_acme-challenge', '_acme-challenge.example.test.'],
  ])('qualifies a relative name %s → %s', (input, expected) => {
    expect(qualifyName(ZONE, input)).toBe(expected);
  });

  it('leaves an absolute name alone', () => {
    expect(qualifyName(ZONE, 'www.example.test.')).toBe('www.example.test.');
  });

  // The regression that published every mail record to `<apex>.<apex>.`:
  // email-domains/dns-provisioning.ts passes the FULL record name.
  it('does NOT glue the zone onto a name that is already the zone apex', () => {
    expect(qualifyName(ZONE, ZONE)).toBe('example.test.');
  });

  it('does NOT glue the zone onto a name already inside the zone', () => {
    expect(qualifyName(ZONE, `sel._domainkey.${ZONE}`)).toBe('sel._domainkey.example.test.');
    expect(qualifyName(ZONE, `_dmarc.${ZONE}`)).toBe('_dmarc.example.test.');
  });

  it('accepts a zone given with a trailing dot', () => {
    expect(qualifyName('example.test.', 'www')).toBe('www.example.test.');
  });

  it('case-folds, since DNS names are case-insensitive', () => {
    expect(qualifyName(ZONE, 'WWW')).toBe('www.example.test.');
  });

  it('treats null/undefined as the apex', () => {
    expect(qualifyName(ZONE, null)).toBe('example.test.');
    expect(qualifyName(ZONE, undefined)).toBe('example.test.');
  });
});

describe('fqdn', () => {
  it('adds a trailing dot exactly once', () => {
    expect(fqdn('example.test')).toBe('example.test.');
    expect(fqdn('example.test.')).toBe('example.test.');
  });
});

describe('splitContent — for providers that take numeric fields separately', () => {
  it('splits an MX preference out of the target', () => {
    expect(splitContent({ type: 'MX', name: '@', content: 'mail.example.test', priority: 10 }))
      .toEqual({ content: 'mail.example.test.', priority: 10 });
  });

  it('parses an MX whose content already carries its preference', () => {
    // Cloudflare/ClouDNS were sent this verbatim alongside a separate
    // priority, so the preference was counted twice.
    expect(splitContent({ type: 'MX', name: '@', content: '20 mail.example.test.' }))
      .toEqual({ content: 'mail.example.test.', priority: 20 });
  });

  it('splits all three SRV fields', () => {
    expect(splitContent({
      type: 'SRV', name: '_sip._tcp', content: 'sip.example.test',
      priority: 10, weight: 5, port: 5060,
    })).toEqual({ content: 'sip.example.test.', priority: 10, weight: 5, port: 5060 });
  });

  it('parses a pre-packed SRV value — the shape mail provisioning emits', () => {
    expect(splitContent({ type: 'SRV', name: '_imaps._tcp', content: '0 1 993 mail.example.test' }))
      .toEqual({ content: 'mail.example.test.', priority: 0, weight: 1, port: 993 });
  });

  it('refuses SRV without weight and port instead of dropping them silently', () => {
    expect(() => splitContent({ type: 'SRV', name: '_x._tcp', content: 'x.example.test', priority: 1 }))
      .toThrow(/priority, weight and port/i);
  });

  it('leaves TXT unquoted — these APIs add their own quoting', () => {
    expect(splitContent({ type: 'TXT', name: '@', content: '"v=spf1 mx ~all"' }))
      .toEqual({ content: 'v=spf1 mx ~all' });
  });

  it('canonicalises hostname targets', () => {
    expect(splitContent({ type: 'CNAME', name: 'x', content: 'target.example.test' }))
      .toEqual({ content: 'target.example.test.' });
  });

  it('agrees with formatContent on what the target is', () => {
    const input = { type: 'MX' as const, name: '@', content: 'mail.example.test', priority: 10 };
    expect(formatContent(input)).toBe(`${splitContent(input).priority} ${splitContent(input).content}`);
  });
});

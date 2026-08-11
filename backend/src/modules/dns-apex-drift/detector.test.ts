import { describe, it, expect } from 'vitest';
import { diffApexRecords, isApexRecordName, buildExpectedApexRecords } from './detector.js';

const A = (content: string) => ({ type: 'A' as const, content });
const AAAA = (content: string) => ({ type: 'AAAA' as const, content });
const rec = (type: string, name: string, content: string) => ({ type, name, content });

describe('isApexRecordName', () => {
  // Providers disagree on how they spell the apex. Treating only one form as
  // the apex would report every domain as "missing everything".
  it('accepts every spelling providers actually return', () => {
    for (const name of ['@', '', 'example.test', 'example.test.', 'EXAMPLE.TEST.']) {
      expect(isApexRecordName(name, 'example.test')).toBe(true);
    }
  });

  it('rejects subdomains', () => {
    expect(isApexRecordName('www.example.test.', 'example.test')).toBe(false);
    expect(isApexRecordName('www', 'example.test')).toBe(false);
  });
});

describe('buildExpectedApexRecords', () => {
  it('maps v4 to A and v6 to AAAA', () => {
    expect(buildExpectedApexRecords(['203.0.113.10'], ['2001:db8::1'])).toEqual([
      A('203.0.113.10'),
      AAAA('2001:db8::1'),
    ]);
  });

  it('handles either family being empty', () => {
    expect(buildExpectedApexRecords(['203.0.113.10'], [])).toEqual([A('203.0.113.10')]);
    expect(buildExpectedApexRecords([], [])).toEqual([]);
  });
});

describe('diffApexRecords', () => {
  it('reports nothing when the zone already matches', () => {
    const diff = diffApexRecords(
      'example.test',
      [A('203.0.113.10')],
      [rec('A', 'example.test.', '203.0.113.10')],
    );
    expect(diff.missing).toEqual([]);
    expect(diff.unmanaged).toEqual([]);
  });

  // The whole point: a node was added, the apex still has the old set.
  it('reports the new ingress address as missing', () => {
    const diff = diffApexRecords(
      'example.test',
      [A('203.0.113.10'), A('203.0.113.11')],
      [rec('A', 'example.test.', '203.0.113.10')],
    );
    expect(diff.missing).toEqual([A('203.0.113.11')]);
    expect(diff.unmanaged).toEqual([]);
  });

  it('reports an address the platform did not place as unmanaged, not missing', () => {
    const diff = diffApexRecords(
      'example.test',
      [A('203.0.113.10')],
      [rec('A', 'example.test.', '203.0.113.10'), rec('A', 'example.test.', '198.51.100.7')],
    );
    expect(diff.missing).toEqual([]);
    expect(diff.unmanaged).toEqual([A('198.51.100.7')]);
  });

  it('handles simultaneous missing and unmanaged', () => {
    const diff = diffApexRecords(
      'example.test',
      [A('203.0.113.10'), A('203.0.113.11')],
      [rec('A', '@', '203.0.113.10'), rec('A', '@', '198.51.100.7')],
    );
    expect(diff.missing).toEqual([A('203.0.113.11')]);
    expect(diff.unmanaged).toEqual([A('198.51.100.7')]);
  });

  it('ignores subdomain records entirely', () => {
    const diff = diffApexRecords(
      'example.test',
      [A('203.0.113.10')],
      [rec('A', 'www.example.test.', '203.0.113.10')],
    );
    expect(diff.missing).toEqual([A('203.0.113.10')]);
    expect(diff.unmanaged).toEqual([]);
  });

  // An apex MX/TXT/NS is normal and unrelated to ingress. Flagging it as
  // unmanaged would be alarming and wrong.
  it('ignores non-address apex types', () => {
    const diff = diffApexRecords(
      'example.test',
      [A('203.0.113.10')],
      [
        rec('A', 'example.test.', '203.0.113.10'),
        rec('MX', 'example.test.', '10 mail.example.test.'),
        rec('TXT', 'example.test.', 'v=spf1 mx ~all'),
        rec('NS', 'example.test.', 'ns1.example.test.'),
        rec('SOA', 'example.test.', 'ns1.example.test. hostmaster.example.test. 1 2 3 4 5'),
      ],
    );
    expect(diff.missing).toEqual([]);
    expect(diff.unmanaged).toEqual([]);
  });

  it('separates the v4 and v6 families', () => {
    const diff = diffApexRecords(
      'example.test',
      [A('203.0.113.10'), AAAA('2001:db8::1')],
      [rec('A', 'example.test.', '203.0.113.10')],
    );
    expect(diff.missing).toEqual([AAAA('2001:db8::1')]);
  });

  it('compares IPv6 case-insensitively', () => {
    const diff = diffApexRecords(
      'example.test',
      [AAAA('2001:DB8::1')],
      [rec('AAAA', 'example.test.', '2001:db8::1')],
    );
    expect(diff.missing).toEqual([]);
    expect(diff.unmanaged).toEqual([]);
  });

  it('deduplicates repeated unmanaged content', () => {
    const diff = diffApexRecords(
      'example.test',
      [],
      [rec('A', 'example.test.', '198.51.100.7'), rec('A', 'example.test.', '198.51.100.7')],
    );
    expect(diff.unmanaged).toEqual([A('198.51.100.7')]);
  });

  it('reports every expected record as missing for an empty zone', () => {
    const diff = diffApexRecords('example.test', [A('203.0.113.10'), AAAA('2001:db8::1')], []);
    expect(diff.missing).toEqual([A('203.0.113.10'), AAAA('2001:db8::1')]);
    expect(diff.unmanaged).toEqual([]);
  });

  // With nothing configured there is no expectation to violate — every apex
  // address becomes "unmanaged" and NOTHING is missing, so a fix is a no-op.
  it('never reports missing when no ingress addresses are configured', () => {
    const diff = diffApexRecords(
      'example.test',
      [],
      [rec('A', 'example.test.', '203.0.113.10')],
    );
    expect(diff.missing).toEqual([]);
    expect(diff.unmanaged).toEqual([A('203.0.113.10')]);
  });
});

import { describe, it, expect } from 'vitest';
import type { AttributedRecord } from '@insula/api-contracts';
import { planHostname, recordNameMatches, isApexRecordName, type ClassifyUnexpected } from './detector.js';

const ZONE = 'example.test';
const SV1: AttributedRecord = { type: 'A', content: '203.0.113.1', servers: ['sv1'] };
const SV2: AttributedRecord = { type: 'A', content: '203.0.113.2', servers: ['sv2'] };
const SV1_V6: AttributedRecord = { type: 'AAAA', content: '2001:db8::1', servers: ['sv1'] };

/** sv-old was removed, sv3 has ingress disabled, sv4 is rebooting; anything else is foreign. */
const classify: ClassifyUnexpected = (r) => {
  if (r.content === '203.0.113.9') return { kind: 'stale', servers: ['sv-old'], reason: 'server-removed' };
  if (r.content === '203.0.113.3') return { kind: 'stale', servers: ['sv3'], reason: 'ingress-disabled' };
  if (r.content === '203.0.113.4') return { kind: 'held', servers: ['sv4'], reason: 'server-not-ready' };
  return null;
};

const plan = (hostname: string, records: Array<[string, string, string]>, expected = [SV1, SV2]) => planHostname({
  hostname,
  recordName: hostname === ZONE ? '@' : hostname.replace(`.${ZONE}`, ''),
  zone: ZONE,
  expected,
  zoneRecords: records.map(([name, type, content]) => ({ name, type, content })),
  classify,
});

describe('recordNameMatches — providers spell names differently', () => {
  it.each([
    ['example.test.', 'example.test', true],
    ['@', 'example.test', true],
    ['', 'example.test', true],
    ['www.example.test.', 'www.example.test', true],
    ['www', 'www.example.test', true],
    ['*.sites.example.test.', '*.sites.example.test', true],
    ['WWW.Example.Test.', 'www.example.test', true],
    ['www.example.test', 'www.example.test', true],   // FQDN without the root dot
    ['*.sites', '*.sites.example.test', true],
    ['www.example.test.', 'example.test', false],
    ['example.test.', 'www.example.test', false],
    ['@', 'www.example.test', false],
    // The apex is not also `<zone>.<zone>` — with or without the root dot.
    ['example.test.', 'example.test.example.test', false],
    ['example.test', 'example.test.example.test', false],
  ])('%s vs %s → %s', (name, host, want) => {
    expect(recordNameMatches(name, host, ZONE)).toBe(want);
  });

  it('the apex helper still answers for the apex', () => {
    expect(isApexRecordName('example.test.', ZONE)).toBe(true);
    expect(isApexRecordName('mail.example.test.', ZONE)).toBe(false);
  });
});

describe('planHostname', () => {
  it('in sync: nothing missing, nothing stale', () => {
    const p = plan(ZONE, [['example.test.', 'A', '203.0.113.1'], ['example.test.', 'A', '203.0.113.2']]);
    expect(p).toMatchObject({ missing: [], stale: [], foreign: [], ok: 2 });
  });

  it('an ADDED server: its address is missing, attributed to it', () => {
    const p = plan(ZONE, [['example.test.', 'A', '203.0.113.1']]);
    expect(p.missing).toEqual([{ type: 'A', content: '203.0.113.2', servers: ['sv2'] }]);
    expect(p.ok).toBe(1);
  });

  it('a REMOVED server: its address is stale, with the reason and the server', () => {
    const p = plan(ZONE, [['example.test.', 'A', '203.0.113.1'], ['example.test.', 'A', '203.0.113.2'], ['example.test.', 'A', '203.0.113.9']]);
    expect(p.stale).toEqual([{ type: 'A', content: '203.0.113.9', servers: ['sv-old'], reason: 'server-removed' }]);
    expect(p.missing).toEqual([]);
  });

  it('a server with ingress DISABLED: stale with that reason', () => {
    const p = plan('www.example.test', [['www.example.test.', 'A', '203.0.113.1'], ['www.example.test.', 'A', '203.0.113.2'], ['www.example.test.', 'A', '203.0.113.3']]);
    expect(p.stale.map((s) => s.reason)).toEqual(['ingress-disabled']);
  });

  it('a CHANGED address: the new one missing and the old one stale at once', () => {
    const p = plan(ZONE, [['example.test.', 'A', '203.0.113.1'], ['example.test.', 'A', '203.0.113.9']]);
    expect(p.missing.map((r) => r.content)).toEqual(['203.0.113.2']);
    expect(p.stale.map((r) => r.content)).toEqual(['203.0.113.9']);
  });

  it('a server that is only NOT READY: its address is held — neither stale nor foreign', () => {
    const p = plan(ZONE, [['example.test.', 'A', '203.0.113.1'], ['example.test.', 'A', '203.0.113.2'], ['example.test.', 'A', '203.0.113.4']]);
    expect(p.held).toEqual([{ type: 'A', content: '203.0.113.4', servers: ['sv4'], reason: 'server-not-ready' }]);
    expect(p.stale).toEqual([]);
    expect(p.foreign).toEqual([]);
  });

  it('an address nobody can attribute is FOREIGN: reported, never stale', () => {
    const p = plan(ZONE, [['example.test.', 'A', '203.0.113.1'], ['example.test.', 'A', '203.0.113.2'], ['example.test.', 'A', '198.51.100.7']]);
    expect(p.foreign).toEqual([{ type: 'A', content: '198.51.100.7' }]);
    expect(p.stale).toEqual([]);
  });

  it('only this exact name counts — a sibling name or another type is not looked at', () => {
    const p = plan(ZONE, [
      ['example.test.', 'A', '203.0.113.1'], ['example.test.', 'A', '203.0.113.2'],
      ['www.example.test.', 'A', '203.0.113.9'],   // other name
      ['example.test.', 'MX', 'mail.example.test.'], // other type
      ['example.test.', 'TXT', '"v=spf1 -all"'],
    ]);
    expect(p).toMatchObject({ missing: [], stale: [], foreign: [], ok: 2 });
  });

  it('wildcards are a name like any other', () => {
    const p = plan('*.sites.example.test', [['*.sites.example.test.', 'A', '203.0.113.1']]);
    expect(p.missing.map((r) => r.content)).toEqual(['203.0.113.2']);
  });

  it('IPv6 compares case-insensitively and per family', () => {
    const p = plan(ZONE, [['example.test.', 'A', '203.0.113.1'], ['example.test.', 'AAAA', '2001:DB8::1']], [SV1, SV1_V6]);
    expect(p).toMatchObject({ missing: [], stale: [], ok: 2 });
  });

  it('IPv6 compares across spellings — an override typed long-hand is not "stale" against the server\'s short form', () => {
    const longHand: AttributedRecord = { type: 'AAAA', content: '2001:DB8:0:0::1', servers: ['sv1'] };
    const p = plan(ZONE, [['example.test.', 'A', '203.0.113.1'], ['example.test.', 'AAAA', '2001:db8::1']], [SV1, longHand]);
    expect(p).toMatchObject({ missing: [], stale: [], foreign: [], ok: 2 });
  });

  it('a value the provider repeats is reported once', () => {
    const p = plan(ZONE, [['example.test.', 'A', '203.0.113.9'], ['example.test.', 'A', '203.0.113.9'], ['example.test.', 'A', '203.0.113.1'], ['example.test.', 'A', '203.0.113.2']]);
    expect(p.stale).toHaveLength(1);
  });

  it('an empty zone: every expected address is missing', () => {
    expect(plan('blog.example.test', []).missing).toHaveLength(2);
  });
});

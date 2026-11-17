import { describe, expect, it } from 'vitest';
import { addressMatcher, canonicalTrustedIp } from './ip-value.js';

const ok = (input: string) => {
  const r = canonicalTrustedIp(input);
  if (!r.ok) throw new Error(`${input}: ${r.message}`);
  return r.value;
};
const refused = (input: string) => {
  const r = canonicalTrustedIp(input);
  if (r.ok) throw new Error(`${input} was accepted as ${r.value}`);
  return r.message;
};

describe('canonicalTrustedIp', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    [' 203.0.113.7 ', '203.0.113.7'],
    ['203.0.113.7/32', '203.0.113.7'],
    ['203.0.113.9/24', '203.0.113.0/24'],
    ['198.51.100.200/25', '198.51.100.128/25'],
    ['2001:DB8:0:0::1', '2001:db8::1'],
    ['2001:db8::1/128', '2001:db8::1'],
    ['2001:db8:1:2:3::9/48', '2001:db8:1::/48'],
    ['2001:db8:1:2:3::9/64', '2001:db8:1:2::/64'],
    ['::ffff:203.0.113.5', '203.0.113.5'],
    ['10.98.0.17', '10.98.0.17'],
  ])('%s is stored as %s', (input, expected) => {
    expect(ok(input)).toBe(expected);
  });

  it('refuses a network wider than /24 or /48', () => {
    expect(refused('203.0.113.0/23')).toMatch(/too wide.*\/24/);
    expect(refused('0.0.0.0/0')).toMatch(/too wide/);
    expect(refused('2001:db8::/47')).toMatch(/too wide.*\/48/);
  });

  it('refuses addresses no request comes from', () => {
    expect(refused('127.0.0.1')).toMatch(/loopback/);
    expect(refused('127.1.2.0/24')).toMatch(/loopback/);
    expect(refused('0.0.0.0')).toMatch(/unspecified/);
    expect(refused('::1')).toMatch(/loopback/);
    expect(refused('::')).toMatch(/unspecified/);
  });

  it.each(['example.test', '203.0.113.256', '203.0.113.7/33', '2001:db8::1/129', '203.0.113.7/24/1', '/24', 'fe80::1%eth0', '203.0.113.7/x', '1.2.3'])(
    'refuses %s', (input) => {
      expect(canonicalTrustedIp(input).ok).toBe(false);
    },
  );
});

describe('addressMatcher', () => {
  it('matches addresses and networks of both families', () => {
    const m = addressMatcher(['203.0.113.7', '198.51.100.0/24', '2001:db8:1::/48']);
    expect(m('203.0.113.7')).toBe(true);
    expect(m('203.0.113.8')).toBe(false);
    expect(m('198.51.100.250')).toBe(true);
    expect(m('2001:db8:1:ffff::1')).toBe(true);
    expect(m('2001:db8:2::1')).toBe(false);
    expect(m('::ffff:203.0.113.7')).toBe(true);
  });

  it('matches nothing when empty, and skips values that do not parse', () => {
    expect(addressMatcher([])('203.0.113.7')).toBe(false);
    const m = addressMatcher(['not-an-ip', '203.0.113.7/99', '203.0.113.7']);
    expect(m('203.0.113.7')).toBe(true);
    expect(m('garbage')).toBe(false);
  });

  it('reads a wide operator allowlist entry as given (the platform allowlist has no prefix floor)', () => {
    expect(addressMatcher(['10.0.0.0/8'])('10.20.30.40')).toBe(true);
  });
});

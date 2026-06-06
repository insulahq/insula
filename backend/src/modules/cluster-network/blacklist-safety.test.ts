import { describe, it, expect } from 'vitest';
import { parseCidr, cidrContainsIp, checkBlacklistLockout, blacklistNameForCidr } from './blacklist-safety.js';

describe('parseCidr', () => {
  it('parses bare v4 → /32', () => {
    expect(parseCidr('203.0.113.10')).toEqual({ address: '203.0.113.10', prefix: 32, family: 'ipv4' });
  });
  it('parses v4 CIDR', () => {
    expect(parseCidr('10.0.0.0/16')).toEqual({ address: '10.0.0.0', prefix: 16, family: 'ipv4' });
  });
  it('parses bare v6 → /128 and v6 CIDR', () => {
    expect(parseCidr('2001:db8::1')).toEqual({ address: '2001:db8::1', prefix: 128, family: 'ipv6' });
    expect(parseCidr('fd00::/8')).toEqual({ address: 'fd00::', prefix: 8, family: 'ipv6' });
  });
  it('rejects junk, out-of-range prefixes', () => {
    expect(parseCidr('not-an-ip')).toBeNull();
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('fd00::/129')).toBeNull();
    expect(parseCidr('')).toBeNull();
  });
});

describe('cidrContainsIp', () => {
  it('membership within a v4 block', () => {
    const block = parseCidr('203.0.113.0/24')!;
    expect(cidrContainsIp(block, '203.0.113.10')).toBe(true);
    expect(cidrContainsIp(block, '203.0.114.1')).toBe(false);
  });
  it('does not cross families', () => {
    const v4 = parseCidr('0.0.0.0/0' === '0.0.0.0/0' ? '10.0.0.0/8' : '10.0.0.0/8')!;
    expect(cidrContainsIp(v4, '2001:db8::1')).toBe(false);
  });
});

describe('checkBlacklistLockout', () => {
  const protectedIps = [
    { ip: '203.0.113.10', kind: 'admin-current-ip' },
    { ip: '10.0.0.5', kind: 'node-internal-ip' },
    { ip: '192.0.2.0/24', kind: 'trusted-range' },
    { ip: '2001:db8:a::1', kind: 'cluster-peer' },
  ];

  it('refuses a ban that equals a protected IP', () => {
    const v = checkBlacklistLockout(parseCidr('203.0.113.10')!, protectedIps);
    expect(v.safe).toBe(false);
    expect(v.hitKind).toBe('admin-current-ip');
  });

  it('refuses a ban whose CIDR contains a protected IP', () => {
    const v = checkBlacklistLockout(parseCidr('10.0.0.0/16')!, protectedIps);
    expect(v.safe).toBe(false);
    expect(v.hitKind).toBe('node-internal-ip');
  });

  it('refuses a ban that falls INSIDE a protected trusted range', () => {
    const v = checkBlacklistLockout(parseCidr('192.0.2.50')!, protectedIps);
    expect(v.safe).toBe(false);
    expect(v.hitKind).toBe('trusted-range');
  });

  it('refuses a protected v6 peer', () => {
    const v = checkBlacklistLockout(parseCidr('2001:db8:a::/64')!, protectedIps);
    expect(v.safe).toBe(false);
    expect(v.hitKind).toBe('cluster-peer');
  });

  it('allows a genuinely hostile IP outside all protected space', () => {
    const v = checkBlacklistLockout(parseCidr('45.148.10.240')!, protectedIps);
    expect(v).toEqual({ safe: true, hitKind: null, hitValue: null });
  });

  it('allows a hostile v4 /24 that touches nothing protected', () => {
    expect(checkBlacklistLockout(parseCidr('45.148.10.0/24')!, protectedIps).safe).toBe(true);
  });
});

describe('blacklistNameForCidr', () => {
  it('makes a DNS-1123 name', () => {
    expect(blacklistNameForCidr('203.0.113.10/32')).toBe('cfb-203-0-113-10-32');
    expect(blacklistNameForCidr('fd00::/8')).toBe('cfb-fd00-8');
  });
});

describe('C1 — IPv4-mapped IPv6 admin IP', () => {
  it('unmaps ::ffff:a.b.c.d so a v4 ban catches the mapped admin IP', () => {
    const protectedIps = [{ ip: '::ffff:10.0.0.5', kind: 'your current IP' }];
    // Operator tries to ban a v4 CIDR that contains their (mapped) real IP.
    const v = checkBlacklistLockout(parseCidr('10.0.0.0/8')!, protectedIps);
    expect(v.safe).toBe(false);
    expect(v.hitKind).toBe('your current IP');
  });
  it('parseCidr classifies ::ffff:1.2.3.4 as ipv4', () => {
    expect(parseCidr('::ffff:1.2.3.4')).toEqual({ address: '1.2.3.4', prefix: 32, family: 'ipv4' });
  });
});

import { describe, it, expect } from 'vitest';
import { ipIsInternal, ipIsRefused, urlHostIsInternalLiteral, guardedFetch, SsrfBlockedError } from './ssrf-guard.js';

describe('ipIsInternal', () => {
  it('flags loopback / private / link-local / CGNAT / metadata', () => {
    for (const ip of [
      '127.0.0.1', '10.0.0.1', '10.42.0.5', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    ]) {
      expect(ipIsInternal(ip), ip).toBe(true);
    }
  });
  it('allows public v4', () => {
    // RFC 5737 documentation ranges + well-known public resolvers — never operator IPs.
    for (const ip of ['1.1.1.1', '8.8.8.8', '203.0.113.10', '198.51.100.7']) {
      expect(ipIsInternal(ip), ip).toBe(false);
    }
  });
  it('flags internal v6 (loopback, ULA, link-local, v4-mapped)', () => {
    for (const ip of ['::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(ipIsInternal(ip), ip).toBe(true);
    }
  });
  it('allows public v6', () => {
    expect(ipIsInternal('2606:4700:4700::1111')).toBe(false);
  });
  it('fails closed for non-IP', () => {
    expect(ipIsInternal('not-an-ip')).toBe(true);
  });
});

describe('urlHostIsInternalLiteral', () => {
  it('blocks literal internal IP hosts (which the DNS lookup never sees)', () => {
    for (const u of [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1/x',
      'https://10.43.0.1/',
      'http://192.168.1.1/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://0.0.0.0/',
    ]) {
      expect(urlHostIsInternalLiteral(u), u).toBe(true);
    }
  });
  it('allows public hosts + public literals', () => {
    expect(urlHostIsInternalLiteral('http://example.com/')).toBe(false);
    expect(urlHostIsInternalLiteral('https://1.1.1.1/')).toBe(false);
    expect(urlHostIsInternalLiteral('http://93.184.216.34/')).toBe(false);
  });
  it('blocks unparseable URLs', () => {
    expect(urlHostIsInternalLiteral('::::::')).toBe(true);
  });
});

describe('guardedFetch', () => {
  it('rejects a literal metadata IP before connecting', async () => {
    await expect(guardedFetch('http://169.254.169.254/')).rejects.toBeInstanceOf(SsrfBlockedError);
  });
  it('rejects a literal cluster ClusterIP', async () => {
    await expect(guardedFetch('https://10.43.0.1/')).rejects.toBeInstanceOf(SsrfBlockedError);
  });
  it('rejects non-http schemes', async () => {
    await expect(guardedFetch('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(guardedFetch('gopher://127.0.0.1/')).rejects.toBeInstanceOf(SsrfBlockedError);
  });
  it('rejects unparseable URLs', async () => {
    await expect(guardedFetch('http://')).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});

describe('ipIsRefused with a policy', () => {
  const cluster = { allowPrivate: true, deniedCidrs: ['10.42.0.0/16', '10.43.0.0/16', 'fd00:42::/56'] };
  it('without a policy refuses what ipIsInternal refuses', () => {
    for (const ip of ['10.0.0.5', '192.168.1.1', '127.0.0.1', '169.254.169.254', 'fd12::1']) expect(ipIsRefused(ip), ip).toBe(true);
    expect(ipIsRefused('1.1.1.1')).toBe(false);
  });
  it('allowPrivate opens the private ranges', () => {
    for (const ip of ['10.0.0.5', '172.20.1.1', '192.168.1.1', '100.64.3.4', 'fd12::1', '::ffff:192.168.1.1']) expect(ipIsRefused(ip, cluster), ip).toBe(false);
  });
  it('loopback, link-local / metadata and the denied ranges stay refused', () => {
    for (const ip of ['127.0.0.1', '0.0.0.0', '169.254.169.254', '::1', 'fe80::1', '::ffff:127.0.0.1', '10.42.3.4', '10.43.0.1', 'fd00:42::10', '::ffff:10.43.0.1']) {
      expect(ipIsRefused(ip, cluster), ip).toBe(true);
    }
  });
  it('a literal URL host follows the same policy', () => {
    expect(urlHostIsInternalLiteral('http://192.168.1.10/catalog.json', cluster)).toBe(false);
    expect(urlHostIsInternalLiteral('http://192.168.1.10/catalog.json')).toBe(true);
    expect(urlHostIsInternalLiteral('http://[::1]/x', cluster)).toBe(true);
    expect(urlHostIsInternalLiteral('http://10.43.0.1/x', cluster)).toBe(true);
  });
  it('guardedFetch refuses loopback even with private ranges allowed', async () => {
    await expect(guardedFetch('http://127.0.0.1:9/x', { policy: cluster })).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('refuses NAT64 (it can embed an internal IPv4), with or without a policy', () => {
    expect(ipIsRefused('64:ff9b::7f00:1')).toBe(true);
    expect(ipIsRefused('64:ff9b::a9fe:a9fe', cluster)).toBe(true);
  });
  it('a malformed or bare denied range never throws; a bare address is its own /32', () => {
    const odd = { allowPrivate: true, deniedCidrs: ['10.9.9.9', '192.168.0.0/33', 'not-a-cidr', '172.20.0.0/-1'] };
    expect(() => ipIsRefused('192.168.1.1', odd)).not.toThrow();
    expect(ipIsRefused('10.9.9.9', odd)).toBe(true);
    expect(ipIsRefused('10.9.9.10', odd)).toBe(false);
  });

  it('refuses the special ranges whatever the policy', () => {
    for (const ip of ['::7f00:1', '::127.0.0.1', 'fec0::1', 'ff02::1', '::ffff:7f00:1', '64:ff9b:1::a', '224.0.0.1', '239.255.255.250', '255.255.255.255', '198.18.0.1', '192.0.0.8']) {
      expect(ipIsRefused(ip, cluster), ip).toBe(true);
      expect(ipIsInternal(ip), ip).toBe(true);
    }
    expect(ipIsRefused('198.51.100.7', cluster)).toBe(false);
  });
});

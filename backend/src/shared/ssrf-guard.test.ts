import { describe, it, expect } from 'vitest';
import { ipIsInternal, urlHostIsInternalLiteral, guardedFetch, SsrfBlockedError } from './ssrf-guard.js';

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

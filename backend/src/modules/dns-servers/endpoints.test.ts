import { describe, it, expect } from 'vitest';
import { dnsApiEndpoint, isCheckableHost, isInClusterHost } from './endpoints.js';

describe('dnsApiEndpoint', () => {
  it('PowerDNS: host and port of api_url, the scheme default when there is none', () => {
    expect(dnsApiEndpoint('powerdns', { api_url: 'http://100.64.0.10:8081', api_key: 'k' })).toEqual({ host: '100.64.0.10', port: 8081 });
    expect(dnsApiEndpoint('powerdns', { api_url: 'https://pdns.example.test/api' })).toEqual({ host: 'pdns.example.test', port: 443 });
    expect(dnsApiEndpoint('powerdns', { api_url: 'http://[2001:db8::53]:8081' })).toEqual({ host: '[2001:db8::53]', port: 8081 });
  });

  it('never returns anything but host and port — no credential travels', () => {
    const ep = dnsApiEndpoint('powerdns', { api_url: 'http://user:secret@pdns.example.test:8081', api_key: 'k' });
    expect(ep).toEqual({ host: 'pdns.example.test', port: 8081 });
    expect(JSON.stringify(ep)).not.toContain('secret');
  });

  it('hosted providers: their fixed API host', () => {
    expect(dnsApiEndpoint('cloudflare', { api_token: 't' })).toEqual({ host: 'api.cloudflare.com', port: 443 });
    expect(dnsApiEndpoint('route53', {})).toEqual({ host: 'route53.amazonaws.com', port: 443 });
    expect(dnsApiEndpoint('cloudns', {})).toEqual({ host: 'api.cloudns.net', port: 443 });
  });

  it('rndc: the control channel host and port; a bare IPv6 gets brackets', () => {
    expect(dnsApiEndpoint('rndc', { server_host: 'ns.example.test', rndc_port: 953 })).toEqual({ host: 'ns.example.test', port: 953 });
    expect(dnsApiEndpoint('rndc', { server_host: '2001:db8::53', rndc_port: 953 })).toEqual({ host: '[2001:db8::53]', port: 953 });
  });

  it('nothing to check, or nothing safe to check → null', () => {
    expect(dnsApiEndpoint('mock', {})).toBeNull();
    expect(dnsApiEndpoint('powerdns', {})).toBeNull();
    expect(dnsApiEndpoint('powerdns', { api_url: 'not a url' })).toBeNull();
    expect(dnsApiEndpoint('powerdns', { api_url: 'file:///etc/passwd' })).toBeNull();
    expect(dnsApiEndpoint('rndc', { server_host: "h'; id", rndc_port: 953 })).toBeNull();
  });
});

describe('isCheckableHost', () => {
  it('accepts exactly what join-node.sh accepts', () => {
    expect(isCheckableHost('pdns.example.test')).toBe(true);
    expect(isCheckableHost('100.64.0.10')).toBe(true);
    expect(isCheckableHost('[2001:db8::53]')).toBe(true);
    expect(isCheckableHost('2001:db8::53')).toBe(false);
    expect(isCheckableHost('a b')).toBe(false);
    expect(isCheckableHost('$(id)')).toBe(false);
  });
});

describe('isInClusterHost', () => {
  it('a name only cluster DNS resolves, or loopback → not checked from the new host', () => {
    for (const h of ['pdns.dns-e2e.svc.cluster.local', 'pdns.dns-e2e.svc', 'pdns.dns-e2e.svc.cluster.local.', 'pdns', 'localhost', '127.0.0.1', '[::1]']) {
      expect(isInClusterHost(h), h).toBe(true);
    }
  });
  it('a routable name or address → checked', () => {
    for (const h of ['100.64.0.10', 'pdns.example.test', '[2001:db8::53]', 'api.cloudflare.com']) {
      expect(isInClusterHost(h), h).toBe(false);
    }
  });
});

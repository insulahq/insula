import { describe, it, expect, beforeEach } from 'vitest';
import {
  dnsResolverSettingsSchema,
  MAX_DNS_RESOLVER_SERVERS,
  partitionByFamily,
} from '@insula/api-contracts';
import {
  resetDnsResolverCache,
  getCachedCustomServers,
  probeDnsResolver,
  DEFAULT_DNS_RESOLVER_SETTINGS,
} from './service.js';

describe('dns-resolver contract', () => {
  it('defaults to host mode with no servers', () => {
    const r = dnsResolverSettingsSchema.parse({ mode: 'host' });
    expect(r.mode).toBe('host');
    expect(r.servers).toEqual([]);
    expect(DEFAULT_DNS_RESOLVER_SETTINGS).toEqual({ mode: 'host', servers: [] });
  });

  it('accepts IPv4 and IPv6 upstreams together (dual-stack)', () => {
    const r = dnsResolverSettingsSchema.safeParse({
      mode: 'custom',
      servers: ['9.9.9.9', '149.112.112.112', '2620:fe::fe', '2620:fe::9'],
    });
    expect(r.success).toBe(true);
    const { ipv4, ipv6 } = partitionByFamily(['9.9.9.9', '2620:fe::fe']);
    expect(ipv4).toEqual(['9.9.9.9']);
    expect(ipv6).toEqual(['2620:fe::fe']);
  });

  it('REFUSES custom mode with an empty server list', () => {
    // Would silently behave as `host` while the UI said `custom`.
    const r = dnsResolverSettingsSchema.safeParse({ mode: 'custom', servers: [] });
    expect(r.success).toBe(false);
  });

  it('caps the list at MAX_DNS_RESOLVER_SERVERS', () => {
    const five = ['1.1.1.1', '8.8.8.8', '9.9.9.9', '8.8.4.4', '1.0.0.1'];
    expect(five.length).toBeGreaterThan(MAX_DNS_RESOLVER_SERVERS);
    expect(dnsResolverSettingsSchema.safeParse({ mode: 'custom', servers: five }).success).toBe(false);
  });

  it('rejects duplicates', () => {
    const r = dnsResolverSettingsSchema.safeParse({ mode: 'custom', servers: ['9.9.9.9', '9.9.9.9'] });
    expect(r.success).toBe(false);
  });

  it('rejects a port, a CIDR, a hostname and octet-overflow', () => {
    for (const bad of ['9.9.9.9:53', '9.9.9.0/24', 'dns.quad9.net', '999.999.999.999', '[2620:fe::fe]:53']) {
      expect(dnsResolverSettingsSchema.safeParse({ mode: 'custom', servers: [bad] }).success).toBe(false);
    }
  });
});

describe('getCachedCustomServers', () => {
  beforeEach(() => resetDnsResolverCache());

  it('returns null on a cold cache so mail keeps its own default', () => {
    // Critical: returning [] here would make mail fall back to the POD
    // resolver, reintroducing the 2026-05-27 CoreDNS PTR-shadowing bug.
    expect(getCachedCustomServers()).toBeNull();
  });
});

describe('probeDnsResolver', () => {
  it('reports failure without throwing when the upstream is unusable', async () => {
    // 203.0.113.0/24 is TEST-NET-3 — guaranteed not to answer.
    const r = await probeDnsResolver(['203.0.113.1'], 'example.com');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('example.com');
  }, 20_000);
});

describe('resilience', () => {
  beforeEach(() => resetDnsResolverCache());

  it('degrades to host mode when the settings row is unreadable', async () => {
    // A DB blip (or a stub db in a caller's test) must not break every DNS
    // lookup the platform makes — verification regressed exactly this way.
    const brokenDb = {
      select: () => ({ from: () => ({ where: async () => { throw new Error('db down'); } }) }),
    } as never;
    const { getDnsResolverSettings } = await import('./service.js');
    await expect(getDnsResolverSettings(brokenDb)).resolves.toEqual({ mode: 'host', servers: [] });
  });
});

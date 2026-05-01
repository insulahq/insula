import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dns.promises
vi.mock('node:dns/promises', () => ({
  default: {
    resolveNs: vi.fn(),
    resolveCname: vi.fn(),
    resolve4: vi.fn(),
    resolve6: vi.fn(),
  },
}));

// Mock dns-servers service (for secondary/AXFR checks)
vi.mock('../dns-servers/service.js', () => ({
  getActiveServers: vi.fn().mockResolvedValue([]),
  getProviderForServer: vi.fn(),
}));

import dns from 'node:dns/promises';
import { getActiveServers, getProviderForServer } from '../dns-servers/service.js';
import { verifyNsDelegation, verifyCnameRecord, verifyDomain, verifyResolvesToIngress } from './verification.js';

const mockResolveNs = vi.mocked(dns.resolveNs);
const mockResolveCname = vi.mocked(dns.resolveCname);
const mockResolve4 = vi.mocked(dns.resolve4);
const mockResolve6 = vi.mocked(dns.resolve6);
const mockGetActiveServers = vi.mocked(getActiveServers);
const mockGetProviderForServer = vi.mocked(getProviderForServer);

const mockDb = {} as Parameters<typeof verifyDomain>[3];

beforeEach(() => {
  vi.clearAllMocks();
  // Default: resolve6 returns ENODATA (most test cases are IPv4-only)
  mockResolve6.mockRejectedValue(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));
  mockResolveCname.mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
});

describe('verifyNsDelegation', () => {
  it('should pass when expected nameservers are present', async () => {
    mockResolveNs.mockResolvedValue(['ns1.platform.com', 'ns2.platform.com']);

    const result = await verifyNsDelegation('example.com', ['ns1.platform.com', 'ns2.platform.com']);
    expect(result.status).toBe('pass');
    expect(result.type).toBe('ns_delegation');
  });

  it('should pass with trailing dots normalized', async () => {
    mockResolveNs.mockResolvedValue(['ns1.platform.com.', 'ns2.platform.com.']);

    const result = await verifyNsDelegation('example.com', ['ns1.platform.com', 'ns2.platform.com']);
    expect(result.status).toBe('pass');
  });

  it('should fail when expected nameservers are missing', async () => {
    mockResolveNs.mockResolvedValue(['ns1.other.com', 'ns2.other.com']);

    const result = await verifyNsDelegation('example.com', ['ns1.platform.com', 'ns2.platform.com']);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Expected NS');
  });

  it('should fail gracefully on DNS timeout/error', async () => {
    mockResolveNs.mockRejectedValue(new Error('ETIMEOUT'));

    const result = await verifyNsDelegation('example.com', ['ns1.platform.com']);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('NS lookup failed');
    expect(result.detail).toContain('ETIMEOUT');
  });
});

describe('verifyCnameRecord (deprecated — legacy exact-match)', () => {
  it('should pass when CNAME points to expected target', async () => {
    mockResolveCname.mockResolvedValue(['ingress.platform.com']);

    const result = await verifyCnameRecord('example.com', 'ingress.platform.com');
    expect(result.status).toBe('pass');
    expect(result.type).toBe('cname_record');
  });

  it('should fail when CNAME points elsewhere', async () => {
    mockResolveCname.mockResolvedValue(['other.host.com']);

    const result = await verifyCnameRecord('example.com', 'ingress.platform.com');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Expected CNAME target');
  });

  it('should fail gracefully on DNS timeout/error', async () => {
    mockResolveCname.mockRejectedValue(new Error('ENOTFOUND'));

    const result = await verifyCnameRecord('example.com', 'ingress.platform.com');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('CNAME lookup failed');
    expect(result.detail).toContain('ENOTFOUND');
  });
});

describe('verifyResolvesToIngress', () => {
  it('passes when customer IPs overlap with ingress IPs', async () => {
    mockResolve4.mockImplementation((hostname: string) => {
      if (hostname === 'customer.example.com') return Promise.resolve(['1.2.3.4', '1.2.3.5']);
      if (hostname === 'ingress.platform.net') return Promise.resolve(['1.2.3.4', '5.6.7.8']);
      return Promise.resolve([]);
    });

    const result = await verifyResolvesToIngress('customer.example.com', 'ingress.platform.net');
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('1.2.3.4');
    expect(result.detail).toContain('matches ingress base IPs');
  });

  it('passes when customer resolves through a CDN chain to ingress IP', async () => {
    mockResolve4.mockImplementation((hostname: string) => {
      if (hostname === 'customer.example.com') return Promise.resolve(['1.2.3.4']);
      if (hostname === 'ingress.platform.net') return Promise.resolve(['1.2.3.4', '5.6.7.8']);
      return Promise.resolve([]);
    });
    mockResolveCname.mockResolvedValue(['cdn.cloudflare.com']);

    const result = await verifyResolvesToIngress('customer.example.com', 'ingress.platform.net');
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('cdn.cloudflare.com');
  });

  it('fails when customer IPs are disjoint from ingress IPs', async () => {
    mockResolve4.mockImplementation((hostname: string) => {
      if (hostname === 'customer.example.com') return Promise.resolve(['9.9.9.9']);
      if (hostname === 'ingress.platform.net') return Promise.resolve(['1.2.3.4']);
      return Promise.resolve([]);
    });

    const result = await verifyResolvesToIngress('customer.example.com', 'ingress.platform.net');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('do not overlap');
    expect(result.detail).toContain('9.9.9.9');
    expect(result.detail).toContain('1.2.3.4');
  });

  it('fails with descriptive message when customer hostname has no records', async () => {
    mockResolve4.mockImplementation((hostname: string) => {
      if (hostname === 'customer.example.com') {
        return Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
      }
      if (hostname === 'ingress.platform.net') return Promise.resolve(['1.2.3.4']);
      return Promise.resolve([]);
    });

    const result = await verifyResolvesToIngress('customer.example.com', 'ingress.platform.net');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('No A/AAAA records resolve for customer.example.com');
  });

  it('fails with operator misconfiguration message when ingress has no records', async () => {
    mockResolve4.mockImplementation((hostname: string) => {
      if (hostname === 'customer.example.com') return Promise.resolve(['1.2.3.4']);
      return Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    });

    const result = await verifyResolvesToIngress('customer.example.com', 'ingress.platform.net');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('operator misconfiguration');
  });

  it('fails when ingress is IPv6-only but customer is IPv4-only (no overlap)', async () => {
    mockResolve4.mockImplementation((hostname: string) => {
      if (hostname === 'customer.example.com') return Promise.resolve(['1.2.3.4']);
      return Promise.reject(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));
    });
    mockResolve6.mockImplementation((hostname: string) => {
      if (hostname === 'customer.example.com') {
        return Promise.reject(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));
      }
      if (hostname === 'ingress.platform.net') return Promise.resolve(['2001:db8::1']);
      return Promise.reject(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));
    });

    const result = await verifyResolvesToIngress('customer.example.com', 'ingress.platform.net');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('do not overlap');
  });
});

describe('verifyDomain', () => {
  const platformConfig = {
    nameservers: ['ns1.platform.com', 'ns2.platform.com'],
    ingressHostname: 'ingress.platform.com',
  };

  it('should dispatch NS check for primary mode', async () => {
    mockResolveNs.mockResolvedValue(['ns1.platform.com', 'ns2.platform.com']);

    const result = await verifyDomain('example.com', 'primary', platformConfig, mockDb);
    expect(result.verified).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].type).toBe('ns_delegation');
  });

  it('should dispatch IP-set check for cname mode', async () => {
    // cname mode now uses verifyResolvesToIngress (IP-set intersection)
    mockResolve4.mockImplementation((hostname: string) => {
      if (hostname === 'example.com') return Promise.resolve(['1.2.3.4']);
      if (hostname === 'ingress.platform.com') return Promise.resolve(['1.2.3.4']);
      return Promise.resolve([]);
    });

    const result = await verifyDomain('example.com', 'cname', platformConfig, mockDb);
    expect(result.verified).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].type).toBe('cname_to_ingress');
  });

  it('should dispatch AXFR check for secondary mode', async () => {
    const mockProvider = {
      getZoneAxfrStatus: vi.fn().mockResolvedValue({ synced: true, lastSoaSerial: 2024010101 }),
    };
    mockGetActiveServers.mockResolvedValue([{ id: 's1' }] as Awaited<ReturnType<typeof getActiveServers>>);
    mockGetProviderForServer.mockReturnValue(mockProvider as unknown as ReturnType<typeof getProviderForServer>);

    const result = await verifyDomain('example.com', 'secondary', platformConfig, mockDb);
    expect(result.verified).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].type).toBe('axfr_sync');
  });

  it('should return verified=false when check fails', async () => {
    mockResolveNs.mockResolvedValue(['ns1.other.com']);

    const result = await verifyDomain('example.com', 'primary', platformConfig, mockDb);
    expect(result.verified).toBe(false);
  });

  it('should return verified=false for secondary when no servers available', async () => {
    mockGetActiveServers.mockResolvedValue([]);

    const result = await verifyDomain('example.com', 'secondary', platformConfig, mockDb);
    expect(result.verified).toBe(false);
    expect(result.checks[0].type).toBe('axfr_sync');
  });
});

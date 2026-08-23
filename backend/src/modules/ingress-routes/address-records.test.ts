import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every provisionManagedRecord call to assert the record SHAPE the
// ingress DNS path requests — A/AAAA straight at the ingress IP(s), never a
// CNAME, with the TTL left to the managed-record default (3600).
const calls: Array<{ type: string; name: string; content: string; ttl?: number }> = [];
vi.mock('../dns-records/service.js', () => ({
  provisionManagedRecord: vi.fn(async (_db, _owner, _domain, record) => {
    calls.push(record);
    return { status: 'published' };
  }),
  syncRecordToProviders: vi.fn(),
  describeSyncFailure: vi.fn(),
  deleteManagedRecords: vi.fn(),
}));

import { provisionIngressAddressRecords } from './service.js';

const db = {} as never;
const domain = { id: 'd1', domainName: 'example.test' };

beforeEach(() => { calls.length = 0; });

describe('provisionIngressAddressRecords', () => {
  it('emits one A per IPv4 and one AAAA per IPv6, no CNAME, default TTL', async () => {
    await provisionIngressAddressRecords(db, domain, '*.sites', {
      ingressBaseDomain: 'ingress.example.net',
      ingressDefaultIpv4: '203.0.113.10, 203.0.113.11',
      ingressDefaultIpv6: '2001:db8::1',
    } as never);

    expect(calls.map((c) => `${c.type} ${c.name} ${c.content}`)).toEqual([
      'A *.sites 203.0.113.10',
      'A *.sites 203.0.113.11',
      'AAAA *.sites 2001:db8::1',
    ]);
    // No CNAME anywhere, and TTL is left undefined so the 3600 default applies.
    expect(calls.some((c) => c.type === 'CNAME')).toBe(false);
    expect(calls.every((c) => c.ttl === undefined)).toBe(true);
  });

  it('emits nothing when no ingress IP is configured', async () => {
    await provisionIngressAddressRecords(db, domain, '@', {
      ingressBaseDomain: 'ingress.example.net',
      ingressDefaultIpv4: null,
      ingressDefaultIpv6: null,
    } as never);
    expect(calls).toEqual([]);
  });
});

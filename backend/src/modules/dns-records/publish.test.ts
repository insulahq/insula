import { describe, it, expect, vi, afterEach } from 'vitest';
import { applyRecordChange } from './publish.js';
import { PowerDnsProvider } from '../dns-servers/providers/powerdns.js';

/**
 * Drives the REAL PowerDnsProvider against an in-memory PowerDNS API that
 * applies PATCH changetypes the way the server does: REPLACE swaps the whole
 * (name, type) set, DELETE drops it. Assertions read the resulting zone — what
 * a resolver would be answered — not the requests that were sent.
 */

interface RRset { name: string; type: string; ttl: number; records: Array<{ content: string; disabled: boolean }> }

const ZONE = 'example.test';
const APEX = 'example.test.';

function fakePowerDns(initial: RRset[], opts: { failPatchNumber?: number } = {}) {
  const rrsets: RRset[] = structuredClone(initial);
  let patches = 0;
  globalThis.fetch = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => {
    if ((init.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify({ name: APEX, rrsets }), { status: 200 });
    }
    patches++;
    if (patches === opts.failPatchNumber) {
      return new Response('{"error":"backend unavailable"}', { status: 500 });
    }
    for (const rr of JSON.parse(String(init.body)).rrsets as Array<RRset & { changetype: string }>) {
      const at = rrsets.findIndex((x) => x.name === rr.name && x.type === rr.type);
      if (rr.changetype === 'DELETE') {
        if (at >= 0) rrsets.splice(at, 1);
      } else {
        const next = { name: rr.name, type: rr.type, ttl: rr.ttl, records: rr.records };
        if (at >= 0) rrsets[at] = next; else rrsets.push(next);
      }
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  return {
    values: (name: string, type: string) =>
      (rrsets.find((r) => r.name === name && r.type === type)?.records ?? []).map((r) => r.content).sort(),
    ttl: (name: string, type: string) => rrsets.find((r) => r.name === name && r.type === type)?.ttl,
  };
}

const provider = () => new PowerDnsProvider({ api_url: 'http://pdns.test:8081', api_key: 'k', server_id: 'localhost', api_version: 'v4' });

const twoApexAddresses = (): RRset[] => [
  { name: APEX, type: 'A', ttl: 3600, records: [{ content: '203.0.113.1', disabled: false }, { content: '203.0.113.2', disabled: false }] },
];

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('applyRecordChange — delete', () => {
  it('withdraws one apex A value and leaves the other answering, at its TTL', async () => {
    const dns = fakePowerDns(twoApexAddresses());

    await applyRecordChange(provider(), ZONE, { action: 'delete', record: { type: 'A', name: '@', content: '203.0.113.1' } });

    expect(dns.values(APEX, 'A')).toEqual(['203.0.113.2']);
    expect(dns.ttl(APEX, 'A')).toBe(3600);
  });

  it('removes a DKIM key PowerDNS stored as split character-strings', async () => {
    const dns = fakePowerDns([
      { name: `sel._domainkey.${APEX}`, type: 'TXT', ttl: 3600, records: [{ content: '"v=DKIM1; k=rsa; p=AAAA" "BBBB"', disabled: false }] },
    ]);

    await applyRecordChange(provider(), ZONE, {
      action: 'delete', record: { type: 'TXT', name: `sel._domainkey.${ZONE}`, content: 'v=DKIM1; k=rsa; p=AAAABBBB' },
    });

    expect(dns.values(`sel._domainkey.${APEX}`, 'TXT')).toEqual([]);
  });

  it('matches an IPv6 address however it is spelled', async () => {
    const dns = fakePowerDns([
      { name: APEX, type: 'AAAA', ttl: 3600, records: [{ content: '2001:db8::1', disabled: false }, { content: '2001:db8::2', disabled: false }] },
    ]);

    await applyRecordChange(provider(), ZONE, { action: 'delete', record: { type: 'AAAA', name: '@', content: '2001:DB8:0:0::1' } });

    expect(dns.values(APEX, 'AAAA')).toEqual(['2001:db8::2']);
  });

  it('surfaces a server failure instead of reporting the value gone', async () => {
    fakePowerDns(twoApexAddresses(), { failPatchNumber: 1 });

    await expect(
      applyRecordChange(provider(), ZONE, { action: 'delete', record: { type: 'A', name: '@', content: '203.0.113.1' } }),
    ).rejects.toThrow(/500/);
  });
});

describe('applyRecordChange — update', () => {
  const edit = (previous?: string, withdrawOnFailure?: boolean) => ({
    action: 'update' as const,
    record: { type: 'A', name: '@', content: '203.0.113.9', ttl: 3600 },
    previous: previous ? { type: 'A', name: '@', content: previous } : undefined,
    withdrawOnFailure,
  });

  it('replaces the edited value, keeps its sibling, and leaves no stale value behind', async () => {
    const dns = fakePowerDns(twoApexAddresses());

    await applyRecordChange(provider(), ZONE, edit('203.0.113.1'));

    expect(dns.values(APEX, 'A')).toEqual(['203.0.113.2', '203.0.113.9']);
  });

  it('leaves the old value published when the caller omits it (another row still holds it)', async () => {
    const dns = fakePowerDns(twoApexAddresses());

    await applyRecordChange(provider(), ZONE, edit(undefined));

    expect(dns.values(APEX, 'A')).toEqual(['203.0.113.1', '203.0.113.2', '203.0.113.9']);
  });

  it('a TTL-only edit rewrites the TTL and withdraws nothing', async () => {
    const dns = fakePowerDns(twoApexAddresses());

    await applyRecordChange(provider(), ZONE, {
      action: 'update',
      record: { type: 'A', name: '@', content: '203.0.113.1', ttl: 600 },
      previous: { type: 'A', name: '@', content: '203.0.113.1' },
    });

    expect(dns.values(APEX, 'A')).toEqual(['203.0.113.1', '203.0.113.2']);
    expect(dns.ttl(APEX, 'A')).toBe(600);
  });

  it('withdraws the new value again when the old one cannot be removed', async () => {
    // PATCH 1 publishes .9, PATCH 2 (removing .1) fails, PATCH 3 withdraws .9.
    const dns = fakePowerDns(twoApexAddresses(), { failPatchNumber: 2 });

    await expect(applyRecordChange(provider(), ZONE, edit('203.0.113.1'))).rejects.toThrow(/500/);

    expect(dns.values(APEX, 'A')).toEqual(['203.0.113.1', '203.0.113.2']);
  });

  it('keeps the new value when another row had already published it', async () => {
    const dns = fakePowerDns(twoApexAddresses(), { failPatchNumber: 2 });

    await expect(applyRecordChange(provider(), ZONE, edit('203.0.113.1', false))).rejects.toThrow(/500/);

    expect(dns.values(APEX, 'A')).toEqual(['203.0.113.1', '203.0.113.2', '203.0.113.9']);
  });
});

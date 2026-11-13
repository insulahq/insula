/**
 * The DMARC source badges. The production case that asked for them: our
 * server, a Gmail forwarder, and a Microsoft 365 customer's inline scanner
 * that re-delivers what it scanned — and that last one must read as RELAY,
 * not as somebody forging the domain. Unknown must stay unknown.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { enrichDmarcSources, resetDmarcSourceFactCaches, type SourceFactsDeps, type SourceFactsDns } from './dmarc-source-facts.js';
import type { DmarcSourceCounts } from './dmarc-summary.js';

const nx = () => Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });

/** select()…where() resolves to no rows (no active-selector override); execute() returns [signed, evidenced] per address. */
function stubDb(signed: Record<string, readonly [number, number]>, opts: { fail?: boolean } = {}) {
  const chain: Record<string, unknown> = {
    from: () => chain, innerJoin: () => chain, where: () => chain,
    then: (res: (v: unknown) => unknown) => Promise.resolve([]).then(res),
  };
  return {
    select: () => chain,
    execute: () => (opts.fail
      ? Promise.reject(new Error('statement timeout'))
      : Promise.resolve({ rows: Object.entries(signed).map(([ip, [n, e]]) => ({ ip, signed: n, evidenced: e })) })),
  } as never;
}

function dns(over: Partial<Record<keyof SourceFactsDns, (n: string) => Promise<unknown>>> = {}): SourceFactsDns {
  return {
    resolveTxt: async (n) => (n === 'shop.example.test' ? [['v=spf1 mx ~all']] : Promise.reject(nx())),
    resolveMx: async (n) => (n === 'shop.example.test' ? [{ exchange: 'mail.example.test', priority: 10 }] : Promise.reject(nx())),
    resolve4: async (n) => (n === 'mail.example.test' ? ['192.0.2.10'] : Promise.reject(nx())),
    resolve6: async () => Promise.reject(nx()),
    reverse: async (ip) => {
      if (ip === '192.0.2.10') return ['mail.example.test'];
      if (ip === '198.51.100.7') return ['eu.scanner.example.net.'];
      if (ip === '2001:db8::99') throw Object.assign(new Error('ETIMEOUT'), { code: 'ETIMEOUT' });
      throw nx();
    },
    ...over,
  } as SourceFactsDns;
}

const row = (sourceIp: string, failCount = 0): DmarcSourceCounts => ({
  sourceIp, policyDomain: 'shop.example.test', messageCount: 10, passCount: 10 - failCount, failCount, lastSeenAt: null,
});

const deps = (over: Partial<SourceFactsDeps> = {}): SourceFactsDeps => ({
  dns: dns(),
  clusterAddresses: async () => ['192.0.2.10', '2001:0db8:0000:0000:0000:0000:0000:0010', '100.64.0.5', '10.1.2.3'],
  ...over,
});

const since = new Date('2026-01-01T00:00:00Z');

describe('enrichDmarcSources', () => {
  beforeEach(() => resetDmarcSourceFactCaches());

  it('our server: CLUSTER + SPF, reverse DNS, not a relay although it signed', async () => {
    const [r] = await enrichDmarcSources(stubDb({ '192.0.2.10': [10, 10] }), [row('192.0.2.10')],
      { policyDomain: 'shop.example.test', since, deps: deps() });
    expect(r).toMatchObject({
      isCluster: true, inSpf: true, isRelay: false, relayedCount: 10,
      reverseDns: 'mail.example.test', reverseDnsStatus: 'found',
    });
  });

  it('a recipient filter re-delivering our signed mail: RELAY, not in SPF, trailing dot dropped from its PTR', async () => {
    const [r] = await enrichDmarcSources(stubDb({ '198.51.100.7': [6, 6] }), [row('198.51.100.7', 4)],
      { policyDomain: 'shop.example.test', since, deps: deps() });
    expect(r).toMatchObject({ isCluster: false, inSpf: false, isRelay: true, relayedCount: 6, reverseDns: 'eu.scanner.example.net' });
  });

  // Anyone can paste `DKIM-Signature: d=…; s=dkim-1` onto forged mail.
  it('a signature header without evidence earns no RELAY', async () => {
    const [r] = await enrichDmarcSources(stubDb({ '198.51.100.7': [6, 0] }), [row('198.51.100.7', 6)],
      { policyDomain: 'shop.example.test', since, deps: deps() });
    expect(r).toMatchObject({ isRelay: false, relayedCount: 6 });
  });

  it('unreadable reports leave the relay count unknown and keep the list', async () => {
    const [r] = await enrichDmarcSources(stubDb({}, { fail: true }), [row('198.51.100.7', 6)],
      { policyDomain: 'shop.example.test', since, deps: deps() });
    expect(r).toMatchObject({ isRelay: false, relayedCount: null, reverseDns: 'eu.scanner.example.net' });
  });

  // A report's addresses are input (a tenant can mail its own rua= address):
  // a forged private address must not probe the node list or internal DNS.
  it('looks up nothing for a private, loopback or malformed address', async () => {
    const seen: string[] = [];
    const spy = dns({ reverse: async (ip) => { seen.push(ip); return ['x.example.test']; } });
    const out = await enrichDmarcSources(stubDb({}), [row('100.64.0.5'), row('10.1.2.3'), row('::1'), row('fd00::1'), row('not-an-ip')],
      { policyDomain: 'shop.example.test', since, deps: deps({ dns: spy }) });
    expect(seen).toEqual([]);
    for (const r of out) expect(r).toMatchObject({ isCluster: null, inSpf: null, reverseDnsStatus: 'unknown', isRelay: false });
  });

  it('cancels what is still in flight when it is done', async () => {
    let cancelled = 0;
    const d = { ...dns(), cancel: () => { cancelled += 1; } };
    await enrichDmarcSources(stubDb({}), [row('192.0.2.10')], { policyDomain: 'shop.example.test', since, deps: deps({ dns: d }) });
    expect(cancelled).toBe(1);
  });

  it('a stranger without our signature is neither: no RELAY, and "no reverse DNS" is said as such', async () => {
    const [r] = await enrichDmarcSources(stubDb({}), [row('203.0.113.9', 10)],
      { policyDomain: 'shop.example.test', since, deps: deps() });
    expect(r).toMatchObject({ isCluster: false, inSpf: false, isRelay: false, relayedCount: 0, reverseDns: null, reverseDnsStatus: 'none' });
  });

  it('matches a cluster address however it is spelled, IPv4-mapped included', async () => {
    const out = await enrichDmarcSources(stubDb({}), [row('2001:db8::10'), row('::ffff:192.0.2.10')],
      { policyDomain: 'shop.example.test', since, deps: deps() });
    expect(out.map((r) => r.isCluster)).toEqual([true, true]);
  });

  it('an unreadable node list leaves CLUSTER unknown and RELAY off, rather than calling our own server a relay', async () => {
    const [r] = await enrichDmarcSources(stubDb({ '192.0.2.10': [10, 10] }), [row('192.0.2.10')], {
      policyDomain: 'shop.example.test', since,
      deps: deps({ clusterAddresses: async () => { throw new Error('forbidden'); } }),
    });
    expect(r.isCluster).toBeNull();
    expect(r.isRelay).toBe(false);
  });

  it('a PTR lookup that times out is unknown, not "none"', async () => {
    const [r] = await enrichDmarcSources(stubDb({}), [row('2001:db8::99')],
      { policyDomain: 'shop.example.test', since, deps: deps() });
    expect(r.reverseDnsStatus).toBe('unknown');
  });

  it('an SPF lookup failure is unknown, not "not listed"', async () => {
    const failing = dns({ resolveTxt: async () => { throw Object.assign(new Error('ESERVFAIL'), { code: 'ESERVFAIL' }); } });
    const [r] = await enrichDmarcSources(stubDb({}), [row('192.0.2.10')],
      { policyDomain: 'shop.example.test', since, deps: deps({ dns: failing }) });
    expect(r.inSpf).toBeNull();
  });

  it('returns nothing for nothing, without touching DNS or the cluster', async () => {
    let touched = false;
    const out = await enrichDmarcSources(stubDb({}), [], {
      policyDomain: 'shop.example.test', since,
      deps: deps({ clusterAddresses: async () => { touched = true; return []; } }),
    });
    expect(out).toEqual([]);
    expect(touched).toBe(false);
  });
});

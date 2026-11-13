/**
 * check_host() against a stub zone. The SPF badge must say "pass" only when the
 * policy domain's record really lists the address, and say nothing (unknown)
 * where this check cannot follow the record — never guess.
 */
import { describe, it, expect, vi } from 'vitest';
import { checkSpf, memoSpfDns, type SpfDns } from './spf-check.js';

function noRecord(): Error {
  return Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });
}

interface Zone {
  txt?: Record<string, string[]>;
  a?: Record<string, string[]>;
  aaaa?: Record<string, string[]>;
  mx?: Record<string, string[]>;
  fail?: Record<string, string>;
}

function stubDns(zone: Zone): SpfDns & { calls: string[] } {
  const calls: string[] = [];
  const lookup = <T>(kind: string, name: string, table: Record<string, T> | undefined): Promise<T> => {
    calls.push(`${kind}:${name}`);
    const code = zone.fail?.[`${kind}:${name}`];
    if (code) return Promise.reject(Object.assign(new Error(code), { code }));
    const v = table?.[name];
    return v === undefined ? Promise.reject(noRecord()) : Promise.resolve(v);
  };
  return {
    calls,
    resolveTxt: (n) => lookup('txt', n, zone.txt).then((l) => l.map((t) => [t])),
    resolve4: (n) => lookup('a', n, zone.a),
    resolve6: (n) => lookup('aaaa', n, zone.aaaa),
    resolveMx: (n) => lookup('mx', n, zone.mx).then((l) => l.map((exchange, i) => ({ exchange, priority: i * 10 }))),
  };
}

describe('checkSpf', () => {
  // The production shape: `v=spf1 mx ~all`, the mail server is the MX.
  const platform: Zone = {
    txt: { 'shop.example.test': ['v=spf1 mx ~all', 'google-site-verification=x'] },
    mx: { 'shop.example.test': ['mail.example.test.'] },
    a: { 'mail.example.test': ['192.0.2.10'] },
    aaaa: { 'mail.example.test': ['2001:db8::10'] },
  };

  it('passes the MX, softfails anyone else', async () => {
    expect(await checkSpf(stubDns(platform), '192.0.2.10', 'shop.example.test')).toBe('pass');
    expect(await checkSpf(stubDns(platform), '2001:db8:0:0::10', 'shop.example.test')).toBe('pass');
    expect(await checkSpf(stubDns(platform), '198.51.100.7', 'shop.example.test')).toBe('softfail');
  });

  it('checks an IPv4-mapped IPv6 address as IPv4', async () => {
    expect(await checkSpf(stubDns(platform), '::ffff:192.0.2.10', 'shop.example.test')).toBe('pass');
  });

  it('follows include and redirect, and honours CIDR lengths and qualifiers', async () => {
    const zone: Zone = {
      txt: {
        'a.example.test': ['v=spf1 -ip4:203.0.113.66 include:_spf.provider.test redirect=b.example.test'],
        '_spf.provider.test': ['v=spf1 ip4:198.51.100.0/24 ip6:2001:db8:5::/48 -all'],
        'b.example.test': ['v=spf1 a/28 ?all'],
      },
      a: { 'b.example.test': ['203.0.113.17'] },
    };
    expect(await checkSpf(stubDns(zone), '198.51.100.200', 'a.example.test')).toBe('pass');
    expect(await checkSpf(stubDns(zone), '2001:db8:5:ffff::1', 'a.example.test')).toBe('pass');
    expect(await checkSpf(stubDns(zone), '203.0.113.66', 'a.example.test')).toBe('fail');
    // Not in the include (its -all is the include's own "no match"), so on to redirect.
    expect(await checkSpf(stubDns(zone), '203.0.113.20', 'a.example.test')).toBe('pass');
    expect(await checkSpf(stubDns(zone), '203.0.113.40', 'a.example.test')).toBe('neutral');
  });

  it('none without a record; permerror for two records or an include of nothing', async () => {
    expect(await checkSpf(stubDns({}), '192.0.2.1', 'nothing.example.test')).toBe('none');
    expect(await checkSpf(stubDns({ txt: { 'd.example.test': ['v=spf1 -all', 'v=spf1 +all'] } }), '192.0.2.1', 'd.example.test')).toBe('permerror');
    expect(await checkSpf(stubDns({ txt: { 'd.example.test': ['v=spf1 include:gone.example.test -all'] } }), '192.0.2.1', 'd.example.test')).toBe('permerror');
  });

  it('a timeout or SERVFAIL is temperror, not "not listed"', async () => {
    const zone: Zone = { ...platform, fail: { 'mx:shop.example.test': 'ESERVFAIL' } };
    expect(await checkSpf(stubDns(zone), '192.0.2.10', 'shop.example.test')).toBe('temperror');
    expect(await checkSpf(stubDns({ fail: { 'txt:x.example.test': 'ETIMEOUT' } }), '192.0.2.1', 'x.example.test')).toBe('temperror');
  });

  it('stops at ten DNS-querying terms', async () => {
    const txt: Record<string, string[]> = {};
    for (let i = 0; i < 11; i++) txt[`l${i}.example.test`] = [`v=spf1 include:l${i + 1}.example.test`];
    txt['l11.example.test'] = ['v=spf1 +all'];
    expect(await checkSpf(stubDns({ txt }), '192.0.2.1', 'l0.example.test')).toBe('permerror');
  });

  it('stops after two void lookups', async () => {
    const zone: Zone = { txt: { 'v.example.test': ['v=spf1 a:x1.example.test a:x2.example.test a:x3.example.test +all'] } };
    expect(await checkSpf(stubDns(zone), '192.0.2.1', 'v.example.test')).toBe('permerror');
  });

  it('says unknown, not fail, for macros and ptr it does not evaluate', async () => {
    expect(await checkSpf(stubDns({ txt: { 'm.example.test': ['v=spf1 exists:%{i}._spf.example.test -all'] } }), '192.0.2.1', 'm.example.test')).toBe('unknown');
    expect(await checkSpf(stubDns({ txt: { 'p.example.test': ['v=spf1 ptr -all'] } }), '192.0.2.1', 'p.example.test')).toBe('unknown');
    // A match before the unsupported term still decides.
    expect(await checkSpf(stubDns({ txt: { 'p.example.test': ['v=spf1 ip4:192.0.2.1 ptr -all'] } }), '192.0.2.1', 'p.example.test')).toBe('pass');
  });

  it('skips a null MX rather than failing on it', async () => {
    const zone: Zone = { txt: { 'n.example.test': ['v=spf1 mx -all'] }, mx: { 'n.example.test': ['.'] } };
    expect(await checkSpf(stubDns(zone), '192.0.2.1', 'n.example.test')).toBe('fail');
  });

  it('a malformed address or term is permerror', async () => {
    expect(await checkSpf(stubDns(platform), 'not-an-ip', 'shop.example.test')).toBe('permerror');
    expect(await checkSpf(stubDns({ txt: { 'e.example.test': ['v=spf1 ip4:300.1.1.1 -all'] } }), '192.0.2.1', 'e.example.test')).toBe('permerror');
  });

  // The record is the tenant's to write and this runs inside a request.
  it('gives up with unknown on a record or a query count no real record needs', async () => {
    const huge = `v=spf1 ${Array.from({ length: 200 }, (_, i) => `ip4:198.51.100.${i % 250}`).join(' ')} -all`;
    expect(await checkSpf(stubDns({ txt: { 'h.example.test': [huge] } }), '192.0.2.1', 'h.example.test')).toBe('unknown');
    // Ten mx terms of ten exchanges each: within the RFC's lookup count, far past the query budget.
    const txt: Record<string, string[]> = { 'q.example.test': [`v=spf1 ${Array.from({ length: 10 }, (_, i) => `mx:m${i}.example.test`).join(' ')} -all`] };
    const mx: Record<string, string[]> = {};
    const a: Record<string, string[]> = {};
    for (let i = 0; i < 10; i++) {
      mx[`m${i}.example.test`] = Array.from({ length: 10 }, (_, j) => `x${i}-${j}.example.test`);
      for (let j = 0; j < 10; j++) a[`x${i}-${j}.example.test`] = ['203.0.113.250'];
    }
    expect(await checkSpf(stubDns({ txt, mx, a }), '192.0.2.1', 'q.example.test')).toBe('unknown');
  });

  it('memoSpfDns fetches one record tree for many addresses', async () => {
    const dns = stubDns(platform);
    const memo = memoSpfDns(dns);
    const spy = vi.spyOn(dns, 'resolveTxt');
    await Promise.all(['192.0.2.10', '198.51.100.1', '198.51.100.2'].map((ip) => checkSpf(memo, ip, 'shop.example.test')));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(dns.calls.filter((c) => c === 'mx:shop.example.test')).toHaveLength(1);
  });
});

/**
 * Unit tests for the deliverability probe set.
 *
 * Coverage strategy: every sub-probe is driven by an injected resolver/
 * connector override so the test never touches real DNS, TLS, or sockets.
 * Each probe is exercised on (a) happy path, (b) the operationally-
 * interesting failure mode, and (c) network-layer errors.
 *
 * For helpers exported from the module (blocklistQueryName, matchSan,
 * parseSanDnsNames, banner/EHLO extractors), pure unit tests verify
 * edge cases.
 */

import dgram from 'node:dgram';
import { describe, expect, it, vi } from 'vitest';
import {
  blocklistQueryName,
  extractBannerHostname,
  extractEhloHostname,
  isNoRecordError,
  isServfailError,
  matchSan,
  parseSanDnsNames,
  probeDeliverability,
  resolverFor,
  type DeliverabilityDeps,
} from './deliverability.js';

function makeDeps(overrides: Partial<DeliverabilityDeps>): DeliverabilityDeps {
  return {
    hostname: 'mail.example.com',
    serverNodeIps: ['198.51.100.10'],
    // Defaults: every override resolves to a "clean" / "happy" state.
    resolveAddresses: async (h) => h === 'mail.example.com' ? { a: ['198.51.100.10'], aaaa: [] } : { a: [], aaaa: [] },
    resolvePtr: async (_ip) => ['mail.example.com'],
    resolveBlocklist: async () => ({ listed: false, reasonTxt: null }),
    tlsConnect: async () => ({
      peerCertificate: { subjectaltname: 'DNS:mail.example.com, DNS:*.example.com' } as never,
      error: null,
    }),
    smtpBannerExchange: async () => ({
      banner: '220 mail.example.com ESMTP Stalwart',
      ehloLine: '250-mail.example.com offers',
      error: null,
    }),
    ...overrides,
  };
}

describe('probeDeliverability — top-level wiring', () => {
  it('returns not_implemented when hostname is missing', async () => {
    const r = await probeDeliverability(makeDeps({ hostname: null }));
    expect(r.status).toBe('not_implemented');
    expect(r.healthy).toBe(true);
    expect(r.summary.skipped).toBeGreaterThan(0);
  });

  it('returns not_implemented when there are no server IPs', async () => {
    const r = await probeDeliverability(makeDeps({ serverNodeIps: [] }));
    expect(r.status).toBe('not_implemented');
    expect(r.healthy).toBe(true);
    // No server IPs → fixed-count probes only would have run
    // (1 forward DNS + 1 AAAA + 0 reverse + 0 blocklists + 1 SAN + 1 banner = 4).
    // The AAAA probe is in the real subProbes array but was missing from
    // expectedSubProbeCount, so this rollup under-reported by one.
    expect(r.summary.skipped).toBe(4);
  });

  it('not_implemented summary counts what WOULD have run (hostname missing, 2 IPs)', async () => {
    const r = await probeDeliverability(makeDeps({
      hostname: null,
      serverNodeIps: ['198.51.100.10', '198.51.100.11'],
    }));
    expect(r.status).toBe('not_implemented');
    // 1 forward + 1 AAAA + 2 reverse + 2×8 blocklists + 1 SAN + 1 banner = 22
    expect(r.summary.skipped).toBe(22);
  });

  it('reports ok with summary when everything passes', async () => {
    const r = await probeDeliverability(makeDeps({}));
    expect(r.status).toBe('ok');
    expect(r.healthy).toBe(true);
    expect(r.summary.fail).toBe(0);
    expect(r.summary.ok).toBeGreaterThan(0);
    // Verify each sub-probe is populated
    expect(r.forwardDns?.severity).toBe('ok');
    expect(r.reverseDns).toHaveLength(1);
    expect(r.reverseDns[0].severity).toBe('ok');
    expect(r.blocklists.length).toBeGreaterThan(0);
    expect(r.certSanMatch?.severity).toBe('ok');
    expect(r.smtpBanner?.severity).toBe('ok');
  });

  it('flips healthy=false when any sub-probe is fail', async () => {
    const r = await probeDeliverability(makeDeps({
      resolvePtr: async () => ['someone-else.example.com'],
    }));
    expect(r.healthy).toBe(false);
    expect(r.summary.fail).toBeGreaterThan(0);
    expect(r.error).toMatch(/deliverability failure/);
  });
});

describe('forward DNS probe', () => {
  it('fails when expected IP is missing from resolution', async () => {
    const r = await probeDeliverability(makeDeps({
      serverNodeIps: ['198.51.100.10', '198.51.100.11'],
      resolveAddresses: async () => ({ a: ['198.51.100.10'], aaaa: [] }),
    }));
    expect(r.forwardDns?.severity).toBe('fail');
    expect(r.forwardDns?.missingIps).toEqual(['198.51.100.11']);
    expect(r.forwardDns?.remediation).toMatch(/Add A record/);
  });

  it('warns when DNS resolves to extra unexpected IPs', async () => {
    const r = await probeDeliverability(makeDeps({
      resolveAddresses: async () => ({ a: ['198.51.100.10', '203.0.113.99'], aaaa: [] }),
    }));
    expect(r.forwardDns?.severity).toBe('warning');
    expect(r.forwardDns?.extraIps).toEqual(['203.0.113.99']);
  });

  it('fails when DNS resolver throws', async () => {
    const r = await probeDeliverability(makeDeps({
      resolveAddresses: async () => { throw new Error('ENOTFOUND'); },
    }));
    expect(r.forwardDns?.severity).toBe('fail');
    expect(r.forwardDns?.actual).toMatch(/ENOTFOUND/);
  });

  // REGRESSION(reported from a live dual-stack install).
  //
  // resolvedIps deliberately merges A + AAAA, but the expected set was built
  // from serverNodeIps alone — IPv4 only. So on a dual-stack cluster every
  // CORRECTLY published AAAA came back as an `extraIp`, and the probe told the
  // operator that their own mail node's IPv6 address was not a cluster server
  // node, on a cluster that was dual-stack end to end and whose Nodes page
  // listed that exact address.
  //
  // It survived because every dual-stack test in this file asserts on
  // `r.ipv6Dns` and none asserted what the FORWARD probe did with the same
  // AAAA — including 'is ok when every mail node has a matching AAAA' below,
  // which passed while forwardDns was reporting a warning on the same data.
  it('does not flag a correctly published AAAA as an extra IP', async () => {
    const r = await probeDeliverability(makeDeps({
      serverNodeIps: ['198.51.100.10'],
      serverNodeIpv6s: ['2001:db8:9::10'],
      resolveAddresses: async () => ({ a: ['198.51.100.10'], aaaa: ['2001:db8:9::10'] }),
    }));
    expect(r.forwardDns?.extraIps).toEqual([]);
    expect(r.forwardDns?.severity).toBe('ok');
  });

  it('still flags an AAAA that belongs to no mail node', async () => {
    const r = await probeDeliverability(makeDeps({
      serverNodeIps: ['198.51.100.10'],
      serverNodeIpv6s: ['2001:db8:9::10'],
      resolveAddresses: async () => ({ a: ['198.51.100.10'], aaaa: ['2001:db8:9::10', '2001:db8:99::1'] }),
    }));
    expect(r.forwardDns?.extraIps).toEqual(['2001:db8:99::1']);
    expect(r.forwardDns?.severity).toBe('warning');
  });

  // A missing AAAA is probeIpv6Dns's finding, not this one's — reporting it in
  // both places would double-count the same gap in the modal's rollup.
  it('does not report a missing AAAA as a missing IP', async () => {
    const r = await probeDeliverability(makeDeps({
      serverNodeIps: ['198.51.100.10'],
      serverNodeIpv6s: ['2001:db8:9::10'],
      resolveAddresses: async () => ({ a: ['198.51.100.10'], aaaa: [] }),
    }));
    expect(r.forwardDns?.missingIps).toEqual([]);
    expect(r.forwardDns?.severity).toBe('ok');
    expect(r.ipv6Dns?.missingIpv6).toEqual(['2001:db8:9::10']);
  });

  // Single-stack must keep flagging a stray AAAA: with serverNodeIpv6s empty
  // the v6 probe is inert, so this comparison is the only thing watching.
  it('flags a stray AAAA on a single-stack cluster', async () => {
    const r = await probeDeliverability(makeDeps({
      serverNodeIps: ['198.51.100.10'],
      serverNodeIpv6s: [],
      resolveAddresses: async () => ({ a: ['198.51.100.10'], aaaa: ['2001:db8:99::1'] }),
    }));
    expect(r.forwardDns?.extraIps).toEqual(['2001:db8:99::1']);
  });
});

describe('IPv6 DNS (AAAA coverage) probe', () => {
  // A dual-stack cluster serving mail over IPv6 with no AAAA published is
  // completely silent: IPv4 carries every connection, so the operator who asked
  // for IPv6 gets none of it and nothing complains.
  it('warns when a dual-stack cluster publishes no AAAA at all', async () => {
    const r = await probeDeliverability(makeDeps({
      serverNodeIpv6s: ['2001:db8:9::10'],
      resolveAddresses: async () => ({ a: ['198.51.100.10'], aaaa: [] }),
    }));
    expect(r.ipv6Dns?.severity).toBe('warning');
    expect(r.ipv6Dns?.clusterIsDualStack).toBe(true);
    expect(r.ipv6Dns?.missingIpv6).toEqual(['2001:db8:9::10']);
    expect(r.ipv6Dns?.remediation).toMatch(/bootstrapped dual-stack/);
  });

  it('warns when only some mail nodes have AAAA', async () => {
    const r = await probeDeliverability(makeDeps({
      serverNodeIpv6s: ['2001:db8:9::10', '2001:db8:9::11'],
      resolveAddresses: async () => ({ a: ['198.51.100.10'], aaaa: ['2001:db8:9::10'] }),
    }));
    expect(r.ipv6Dns?.severity).toBe('warning');
    expect(r.ipv6Dns?.missingIpv6).toEqual(['2001:db8:9::11']);
  });

  it('warns on a stale AAAA that is not a mail node', async () => {
    const r = await probeDeliverability(makeDeps({
      serverNodeIpv6s: ['2001:db8:9::10'],
      resolveAddresses: async () => ({ a: ['198.51.100.10'], aaaa: ['2001:db8:9::10', '2001:db8:99::1'] }),
    }));
    expect(r.ipv6Dns?.severity).toBe('warning');
    expect(r.ipv6Dns?.extraIpv6).toEqual(['2001:db8:99::1']);
    // No IPv4 fallback exists for a specific bad AAAA — the client just fails.
    expect(r.ipv6Dns?.remediation).toMatch(/no IPv4 fallback/);
  });

  it('is ok when every mail node has a matching AAAA', async () => {
    const r = await probeDeliverability(makeDeps({
      serverNodeIpv6s: ['2001:db8:9::10'],
      resolveAddresses: async () => ({ a: ['198.51.100.10'], aaaa: ['2001:db8:9::10'] }),
    }));
    expect(r.ipv6Dns?.severity).toBe('ok');
  });

  // Single-stack is the overwhelming majority of installs. This probe must be
  // inert there — a warning on every existing cluster would be noise, and the
  // opposite failure (AAAA published on a single-stack cluster) is caught by
  // smoke test 10, which can see the cluster's actual pod CIDRs.
  it('is skipped on a single-stack cluster, and never warns', async () => {
    const r = await probeDeliverability(makeDeps({ serverNodeIpv6s: [] }));
    expect(r.ipv6Dns?.severity).toBe('skipped');
    expect(r.ipv6Dns?.clusterIsDualStack).toBe(false);
    expect(r.ipv6Dns?.remediation).toBeNull();
  });

  it('treats the probe as skipped when the AAAA lookup itself errors', async () => {
    const r = await probeDeliverability(makeDeps({
      serverNodeIpv6s: ['2001:db8:9::10'],
      resolveAddresses: async () => { throw new Error('SERVFAIL'); },
    }));
    expect(r.ipv6Dns?.severity).toBe('skipped');
    expect(r.ipv6Dns?.actual).toMatch(/SERVFAIL/);
  });

  // The whole component must stay `healthy` — mail works fine over IPv4, and
  // red-lighting the dashboard over a reachability nicety trains operators to
  // ignore it.
  it('never flips the deliverability component to unhealthy', async () => {
    const r = await probeDeliverability(makeDeps({
      serverNodeIpv6s: ['2001:db8:9::10'],
      resolveAddresses: async () => ({ a: ['198.51.100.10'], aaaa: [] }),
    }));
    expect(r.healthy).toBe(true);
    expect(r.summary.fail).toBe(0);
    expect(r.summary.warning).toBeGreaterThanOrEqual(1);
  });
});

describe('reverse DNS / FCrDNS probe', () => {
  it('reports ok per IP when PTR matches', async () => {
    const r = await probeDeliverability(makeDeps({
      serverNodeIps: ['198.51.100.10', '198.51.100.11'],
      resolveAddresses: async () => ({ a: ['198.51.100.10', '198.51.100.11'], aaaa: [] }),
      resolvePtr: async () => ['mail.example.com'],
    }));
    expect(r.reverseDns).toHaveLength(2);
    expect(r.reverseDns.every((p) => p.severity === 'ok')).toBe(true);
  });

  it('fails when PTR doesn\'t match hostname', async () => {
    const r = await probeDeliverability(makeDeps({
      resolvePtr: async () => ['static-198-51-100-10.isp.example.net'],
    }));
    expect(r.reverseDns[0].severity).toBe('fail');
    expect(r.reverseDns[0].fcrdnsOk).toBe(false);
    expect(r.reverseDns[0].remediation).toMatch(/Update reverse DNS/);
  });

  it('handles PTR records with trailing dots', async () => {
    const r = await probeDeliverability(makeDeps({
      resolvePtr: async () => ['mail.example.com.'],
    }));
    expect(r.reverseDns[0].severity).toBe('ok');
  });

  // PTR used to be checked for IPv4 only, so on a dual-stack cluster the IPv6
  // mail addresses — which outbound mail genuinely uses as a fallback — had no
  // reverse-DNS signal at all. A receiver reachable only over IPv6 would see an
  // unauthenticated source and nothing in the health card said so.
  it('checks PTR for IPv6 mail addresses too, not just IPv4', async () => {
    const r = await probeDeliverability(makeDeps({
      serverNodeIps: ['198.51.100.10'],
      serverNodeIpv6s: ['2001:db8:9::10'],
      resolveAddresses: async () => ({ a: ['198.51.100.10'], aaaa: ['2001:db8:9::10'] }),
      resolvePtr: async () => ['mail.example.com'],
    }));
    expect(r.reverseDns).toHaveLength(2);
    expect(r.reverseDns.map((p) => p.ip)).toContain('2001:db8:9::10');
    expect(r.reverseDns.every((p) => p.severity === 'ok')).toBe(true);
  });

  // Severity differs by family ON PURPOSE. Stalwart's default IP strategy is
  // V4ThenV6, so IPv4 carries essentially all outbound mail: no PTR there is a
  // hard failure. IPv6 is only the fallback, so a missing PTR degrades delivery
  // to IPv6-only receivers while everything else keeps flowing — reporting that
  // as `fail` would paint every dual-stack cluster red over something that is
  // not stopping mail. PTR is external config; it is reported, never enforced.
  it('reports a missing IPv6 PTR as warning, while IPv4 stays fail', async () => {
    const r = await probeDeliverability(makeDeps({
      serverNodeIps: ['198.51.100.10'],
      serverNodeIpv6s: ['2001:db8:9::10'],
      resolveAddresses: async () => ({ a: ['198.51.100.10'], aaaa: ['2001:db8:9::10'] }),
      resolvePtr: async () => { throw new Error('NXDOMAIN'); },
    }));
    const v4 = r.reverseDns.find((p) => !p.ip.includes(':'));
    const v6 = r.reverseDns.find((p) => p.ip.includes(':'));
    expect(v4?.severity).toBe('fail');
    expect(v6?.severity).toBe('warning');
    expect(v6?.remediation).toMatch(/fallback path/);
    // Never phrased as a precondition for sending.
    expect(v6?.remediation ?? '').not.toMatch(/before you enable/i);
  });

  it('fails when PTR lookup throws (no PTR configured)', async () => {
    const r = await probeDeliverability(makeDeps({
      resolvePtr: async () => { throw new Error('ENOTFOUND'); },
    }));
    expect(r.reverseDns[0].severity).toBe('fail');
    expect(r.reverseDns[0].remediation).toMatch(/Configure reverse DNS/);
  });
});

describe('DNSBL probes', () => {
  it('produces N×M probes (IPs × blocklists)', async () => {
    const r = await probeDeliverability(makeDeps({
      serverNodeIps: ['198.51.100.10', '198.51.100.11'],
      resolveAddresses: async () => ({ a: ['198.51.100.10', '198.51.100.11'], aaaa: [] }),
    }));
    // 8 lists × 2 IPs = 16
    expect(r.blocklists).toHaveLength(16);
  });

  it('marks Spamhaus ZEN listing as fail', async () => {
    const r = await probeDeliverability(makeDeps({
      resolveBlocklist: async (zone) => ({
        listed: zone === 'zen.spamhaus.org',
        reasonTxt: zone === 'zen.spamhaus.org' ? 'https://www.spamhaus.org/sbl/query/SBL12345' : null,
      }),
    }));
    const zen = r.blocklists.find((b) => b.zone === 'zen.spamhaus.org');
    expect(zen?.severity).toBe('fail');
    expect(zen?.listed).toBe(true);
    expect(zen?.reasonTxt).toMatch(/spamhaus/i);
    expect(r.healthy).toBe(false);
  });

  it('marks UCEPROTECT L1 listing as advisory (doesn\'t flip healthy)', async () => {
    const r = await probeDeliverability(makeDeps({
      resolveBlocklist: async (zone) => ({
        listed: zone === 'dnsbl-1.uceprotect.net',
        reasonTxt: null,
      }),
    }));
    const uce = r.blocklists.find((b) => b.zone === 'dnsbl-1.uceprotect.net');
    expect(uce?.severity).toBe('advisory');
    expect(uce?.listed).toBe(true);
    expect(r.healthy).toBe(true);
    expect(r.summary.fail).toBe(0);
    expect(r.summary.advisory).toBe(1);
  });

  it('marks lookup errors as skipped (not fail)', async () => {
    const r = await probeDeliverability(makeDeps({
      resolveBlocklist: async () => { throw new Error('SERVFAIL'); },
    }));
    expect(r.blocklists.every((b) => b.severity === 'skipped')).toBe(true);
    expect(r.healthy).toBe(true);
  });

  it('treats ENODATA errors as skipped, NOT clean (no false negative)', async () => {
    // Regression: previous version mapped ENODATA → listed:false (clean),
    // which could miss listings on zones that publish CNAME/TXT-only
    // records. After the fix, ENODATA bubbles up and the outer catch
    // reports the probe as `skipped`.
    const r = await probeDeliverability(makeDeps({
      resolveBlocklist: async () => {
        const e = new Error('queryA ENODATA');
        (e as NodeJS.ErrnoException).code = 'ENODATA';
        throw e;
      },
    }));
    expect(r.blocklists.every((b) => b.severity === 'skipped')).toBe(true);
  });

  it('downgrades Spamhaus open-resolver refusal to skipped + surfaces per-IP lookup URL', async () => {
    // Spamhaus returns 127.255.255.254 + TXT explaining the query came
    // via a public/open recursive resolver. Pre-fix the probe reported
    // this as `severity: fail, listed: true` — a false positive that
    // flipped the health card to red even though delivery was fine.
    // Iteration 2: the surfaced URL must contain the ACTUAL CLUSTER IP
    // (not the resolver IP from Spamhaus's confused TXT) so the
    // operator can click through to a real web-form lookup.
    const r = await probeDeliverability(makeDeps({
      serverNodeIps: ['198.51.100.10'],
      resolveBlocklist: async (zone) => {
        if (zone === 'zen.spamhaus.org') {
          return {
            listed: false,
            reasonTxt: 'Error: open resolver; https://check.spamhaus.org/returnc/pub/172.68.24.5/',
            error: 'open_resolver',
          };
        }
        return { listed: false, reasonTxt: null };
      },
    }));
    const zen = r.blocklists.find((b) => b.zone === 'zen.spamhaus.org');
    expect(zen?.severity).toBe('skipped');
    expect(zen?.listed).toBe(false);
    expect(zen?.actual).toMatch(/open_resolver/);
    // lookupUrl MUST have the CLUSTER IP, NOT the resolver IP from Spamhaus's TXT.
    expect(zen?.lookupUrl).toBe('https://check.spamhaus.org/results?query=198.51.100.10');
    expect(zen?.lookupUrl).not.toContain('172.68.24.5');
    // Remediation includes the same per-IP URL so the operator can
    // click through from the modal text too.
    expect(zen?.remediation).toContain('https://check.spamhaus.org/results?query=198.51.100.10');
    expect(r.healthy).toBe(true);
  });

  it('surfaces per-IP lookup URL for real listings (not a homepage link)', async () => {
    const r = await probeDeliverability(makeDeps({
      resolveBlocklist: async (zone) => ({
        listed: zone === 'b.barracudacentral.org',
        reasonTxt: null,
      }),
    }));
    const barracuda = r.blocklists.find((b) => b.zone === 'b.barracudacentral.org');
    expect(barracuda?.severity).toBe('fail');
    expect(barracuda?.listed).toBe(true);
    expect(barracuda?.lookupUrl).toContain('198.51.100.10');
    expect(barracuda?.lookupUrl).toMatch(/^https:/);
  });
});

describe('cert SAN match probe', () => {
  it('matches exact SAN', async () => {
    const r = await probeDeliverability(makeDeps({
      tlsConnect: async () => ({
        peerCertificate: { subjectaltname: 'DNS:mail.example.com' } as never,
        error: null,
      }),
    }));
    expect(r.certSanMatch?.severity).toBe('ok');
    expect(r.certSanMatch?.matched).toBe(true);
  });

  it('matches wildcard SAN', async () => {
    const r = await probeDeliverability(makeDeps({
      tlsConnect: async () => ({
        peerCertificate: { subjectaltname: 'DNS:*.example.com' } as never,
        error: null,
      }),
    }));
    expect(r.certSanMatch?.severity).toBe('ok');
  });

  it('fails when SAN doesn\'t include hostname', async () => {
    const r = await probeDeliverability(makeDeps({
      tlsConnect: async () => ({
        peerCertificate: { subjectaltname: 'DNS:other.example.com, DNS:another.example.com' } as never,
        error: null,
      }),
    }));
    expect(r.certSanMatch?.severity).toBe('fail');
    expect(r.certSanMatch?.matched).toBe(false);
    expect(r.certSanMatch?.remediation).toMatch(/SubjectAltName/);
  });

  it('fails when TLS connector returns an error', async () => {
    const r = await probeDeliverability(makeDeps({
      tlsConnect: async () => ({ peerCertificate: null, error: 'ECONNREFUSED' }),
    }));
    expect(r.certSanMatch?.severity).toBe('fail');
    expect(r.certSanMatch?.actual).toMatch(/ECONNREFUSED/);
  });
});

describe('SMTP banner / EHLO probe', () => {
  it('reports ok when banner + EHLO both match hostname', async () => {
    const r = await probeDeliverability(makeDeps({
      smtpBannerExchange: async () => ({
        banner: '220 mail.example.com ESMTP Stalwart 0.16.0',
        ehloLine: '250-mail.example.com offers',
        error: null,
      }),
    }));
    expect(r.smtpBanner?.severity).toBe('ok');
    expect(r.smtpBanner?.bannerMatches).toBe(true);
    expect(r.smtpBanner?.ehloMatches).toBe(true);
  });

  it('fails when banner hostname differs from configured', async () => {
    const r = await probeDeliverability(makeDeps({
      smtpBannerExchange: async () => ({
        banner: '220 some-other-host.local ESMTP Stalwart',
        ehloLine: '250-some-other-host.local',
        error: null,
      }),
    }));
    expect(r.smtpBanner?.severity).toBe('fail');
    expect(r.smtpBanner?.remediation).toMatch(/defaultHostname/);
  });

  it('skips when SMTP exchange returns connection error', async () => {
    const r = await probeDeliverability(makeDeps({
      smtpBannerExchange: async () => ({ banner: null, ehloLine: null, error: 'ECONNREFUSED' }),
    }));
    expect(r.smtpBanner?.severity).toBe('skipped');
    expect(r.healthy).toBe(true); // skipped doesn't flip healthy
  });
});

describe('blocklistQueryName', () => {
  it('reverses IPv4 octets', () => {
    expect(blocklistQueryName('1.2.3.4', 'zen.spamhaus.org'))
      .toBe('4.3.2.1.zen.spamhaus.org');
  });

  it('handles IPv6 (best-effort)', () => {
    const q = blocklistQueryName('2001:db8::1', 'zen.spamhaus.org');
    expect(q).toMatch(/zen\.spamhaus\.org$/);
    // Reversed nibbles end with the zone
    expect(q.split('.').length).toBeGreaterThan(30);
  });

  it('throws on invalid IPv4', () => {
    expect(() => blocklistQueryName('notanip', 'z.example.com')).toThrow();
  });

  it('rejects IPv6 with zone-ID suffix', () => {
    // Link-local zone IDs (e.g. fe80::1%eth0) would otherwise produce
    // a garbled query name and silently NXDOMAIN. Better to throw and
    // let the outer catch mark the probe as `skipped`.
    expect(() => blocklistQueryName('fe80::1%eth0', 'zen.spamhaus.org')).toThrow(/zone ID/);
  });
});

describe('parseSanDnsNames', () => {
  it('extracts DNS entries from Node\'s subjectaltname format', () => {
    expect(parseSanDnsNames('DNS:a.example.com, DNS:b.example.com, IP Address:1.2.3.4'))
      .toEqual(['a.example.com', 'b.example.com']);
  });

  it('lowercases entries', () => {
    expect(parseSanDnsNames('DNS:Mail.Example.COM'))
      .toEqual(['mail.example.com']);
  });

  it('handles empty input', () => {
    expect(parseSanDnsNames('')).toEqual([]);
  });
});

describe('matchSan', () => {
  it('matches exact hostname', () => {
    expect(matchSan('mail.example.com', ['mail.example.com'])).toBe(true);
  });

  it('matches wildcard prefix', () => {
    expect(matchSan('mail.example.com', ['*.example.com'])).toBe(true);
  });

  it('does NOT match wildcard across multiple labels', () => {
    // *.example.com matches mail.example.com but not deep.mail.example.com (RFC 6125)
    expect(matchSan('deep.mail.example.com', ['*.example.com'])).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(matchSan('MAIL.EXAMPLE.COM', ['mail.example.com'])).toBe(true);
  });

  it('does NOT match if hostname has no dot', () => {
    expect(matchSan('localhost', ['*.example.com'])).toBe(false);
  });
});

describe('banner / EHLO extractors', () => {
  it('extracts banner hostname after 220', () => {
    expect(extractBannerHostname('220 mail.example.com ESMTP Stalwart 0.16')).toBe('mail.example.com');
  });

  it('extracts banner hostname even with dash separator', () => {
    expect(extractBannerHostname('220-mail.example.com')).toBe('mail.example.com');
  });

  it('returns null for non-220 lines', () => {
    expect(extractBannerHostname('500 oops')).toBeNull();
    expect(extractBannerHostname(null)).toBeNull();
  });

  it('extracts EHLO hostname after 250-', () => {
    expect(extractEhloHostname('250-mail.example.com offers')).toBe('mail.example.com');
  });

  it('extracts EHLO hostname after 250 (space)', () => {
    expect(extractEhloHostname('250 mail.example.com')).toBe('mail.example.com');
  });
});

// Every per-address row names the mail endpoint node and the address family,
// so the operator sees exactly WHAT was tested (and can tell a standby or an
// unassigned node was not).
describe('per-address labels (node + family)', () => {
  const addressNodes = {
    '198.51.100.10': 'node-1',
    '2001:db8::10': 'node-1',
    '198.51.100.11': 'node-2',
  };

  it('labels every PTR and DNSBL row with its endpoint node and family', async () => {
    const r = await probeDeliverability(makeDeps({
      serverNodeIps: ['198.51.100.10', '198.51.100.11'],
      serverNodeIpv6s: ['2001:db8::10'],
      addressNodes,
      resolveAddresses: async () => ({ a: ['198.51.100.10', '198.51.100.11'], aaaa: ['2001:db8::10'] }),
    }));
    expect(r.reverseDns.map((p) => [p.ip, p.node, p.family])).toEqual([
      ['198.51.100.10', 'node-1', 'ipv4'],
      ['198.51.100.11', 'node-2', 'ipv4'],
      ['2001:db8::10', 'node-1', 'ipv6'],
    ]);
    expect(r.blocklists.length).toBe(2 * 8);
    for (const b of r.blocklists) {
      expect(b.node).toBe(addressNodes[b.ip as keyof typeof addressNodes]);
      expect(b.family).toBe('ipv4');
    }
  });

  it('an address with no known node is labelled null, never guessed', async () => {
    const r = await probeDeliverability(makeDeps({}));
    expect(r.reverseDns[0]).toEqual(expect.objectContaining({ ip: '198.51.100.10', node: null, family: 'ipv4' }));
  });

  it('a missing A record names the endpoint node in the remediation', async () => {
    const r = await probeDeliverability(makeDeps({
      serverNodeIps: ['198.51.100.10', '198.51.100.11'],
      addressNodes,
      resolveAddresses: async () => ({ a: ['198.51.100.10'], aaaa: [] }),
    }));
    expect(r.forwardDns?.assertion).toMatch(/every mail endpoint IP/);
    expect(r.forwardDns?.remediation).toContain('198.51.100.11 (node-2)');
  });

  it('an A record for a node that publishes no mail port is a warning that says so', async () => {
    const r = await probeDeliverability(makeDeps({
      resolveAddresses: async () => ({ a: ['198.51.100.10', '198.51.100.11'], aaaa: [] }),
    }));
    expect(r.forwardDns?.severity).toBe('warning');
    expect(r.forwardDns?.remediation).toMatch(/publish no mail ports/);
  });

  it('no endpoint address → not_implemented with a placement / exposure hint', async () => {
    const r = await probeDeliverability(makeDeps({ serverNodeIps: [] }));
    expect(r.forwardDns?.remediation).toMatch(/No mail endpoint IPv4 address/);
    expect(r.forwardDns?.remediation).toMatch(/port-exposure mode/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// "No answer" is not "no record"
// ─────────────────────────────────────────────────────────────────────
//
// Production sent "[MAIL] deliverability check failing … Mail delivery is likely
// affected" three times in a week over reverse DNS that was correct throughout.
// Each was one lookup that got no answer inside its 3 s, reported as a missing
// PTR record.

const dnsError = (code: string, syscall = 'queryPtr'): Error => {
  const e = new Error(`${syscall} ${code} 10.100.51.198.in-addr.arpa`);
  (e as NodeJS.ErrnoException).code = code;
  return e;
};

describe('isNoRecordError', () => {
  it('is true only when DNS answered that the name or record does not exist', () => {
    expect(isNoRecordError(dnsError('ENOTFOUND'))).toBe(true);
    expect(isNoRecordError(dnsError('ENODATA'))).toBe(true);
    // A resolver without codes (an injected one, another library): by its words.
    expect(isNoRecordError(new Error('NXDOMAIN'))).toBe(true);
    expect(isNoRecordError(new Error('queryPtr ENOTFOUND 10.100.51.198.in-addr.arpa'))).toBe(true);
  });

  it('is false for everything that is no answer at all', () => {
    for (const code of ['ETIMEOUT', 'ESERVFAIL', 'EREFUSED', 'ECONNREFUSED', 'ECANCELLED', 'EBADRESP']) {
      expect(isNoRecordError(dnsError(code))).toBe(false);
    }
    expect(isNoRecordError(new Error('Reverse DNS lookup for 198.51.100.10 timed out'))).toBe(false);
    expect(isNoRecordError(new Error('SERVFAIL'))).toBe(false);
    expect(isNoRecordError('socket hang up')).toBe(false);
    expect(isNoRecordError(null)).toBe(false);
    expect(isNoRecordError(undefined)).toBe(false);
  });

  it('trusts the code over the message', () => {
    // A timeout whose message happens to quote the name it was looking for.
    const e = new Error('query for ENOTFOUND.example.test');
    (e as NodeJS.ErrnoException).code = 'ETIMEOUT';
    expect(isNoRecordError(e)).toBe(false);
  });
});

describe('a lookup that got no answer is "could not check", never a failure', () => {
  for (const [name, err] of [
    ['a timeout from the resolver', dnsError('ETIMEOUT')],
    ['a refused query', dnsError('EREFUSED')],
    ['an unreachable resolver', dnsError('ECONNREFUSED')],
  ] as const) {
    it(`reverse DNS: ${name} is skipped for IPv4 AND IPv6, and the component stays healthy`, async () => {
      const r = await probeDeliverability(makeDeps({
        serverNodeIps: ['198.51.100.10'],
        serverNodeIpv6s: ['2001:db8:9::10'],
        resolveAddresses: async () => ({ a: ['198.51.100.10'], aaaa: ['2001:db8:9::10'] }),
        resolvePtr: async () => { throw err; },
      }));
      expect(r.reverseDns.map((p) => p.severity)).toEqual(['skipped', 'skipped']);
      expect(r.reverseDns[0].actual).toMatch(/^lookup got no answer: /);
      expect(r.reverseDns[0].remediation).toMatch(/NOT a finding about the record/);
      // The old text told the operator to go and configure reverse DNS.
      expect(r.reverseDns[0].remediation).not.toMatch(/Configure reverse DNS|No PTR record/);
      expect(r.reverseDns[0].fcrdnsOk).toBe(false);
      expect(r.healthy).toBe(true);
      expect(r.error).toBeNull();
      expect(r.summary.fail).toBe(0);
      expect(r.summary.skipped).toBe(2);
    });
  }

  it('reverse DNS: a lookup that never returns is skipped once its own budget is spent', async () => {
    vi.useFakeTimers();
    try {
      const pending = probeDeliverability(makeDeps({ resolvePtr: () => new Promise<string[]>(() => {}) }));
      await vi.advanceTimersByTimeAsync(3_100);
      const r = await pending;
      expect(r.reverseDns[0].severity).toBe('skipped');
      expect(r.reverseDns[0].actual).toMatch(/timed out/);
      expect(r.healthy).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reverse DNS: "no such record" is still a failure for IPv4 — that one is a fact', async () => {
    const r = await probeDeliverability(makeDeps({ resolvePtr: async () => { throw dnsError('ENOTFOUND'); } }));
    expect(r.reverseDns[0].severity).toBe('fail');
    expect(r.reverseDns[0].remediation).toMatch(/Configure reverse DNS/);
    expect(r.healthy).toBe(false);
  });

  it('forward DNS: a lookup that got no answer is skipped, with no address reported missing', async () => {
    const r = await probeDeliverability(makeDeps({ resolveAddresses: async () => { throw dnsError('ETIMEOUT', 'queryA'); } }));
    expect(r.forwardDns?.severity).toBe('skipped');
    expect(r.forwardDns?.actual).toMatch(/^lookup got no answer: /);
    expect(r.forwardDns?.missingIps).toEqual([]);
    expect(r.forwardDns?.remediation).not.toMatch(/Add A record|Verify the A record/);
    expect(r.healthy).toBe(true);
  });

  it('forward DNS: a name that does not exist is still a failure', async () => {
    const r = await probeDeliverability(makeDeps({ resolveAddresses: async () => { throw dnsError('ENOTFOUND', 'queryA'); } }));
    expect(r.forwardDns?.severity).toBe('fail');
    expect(r.forwardDns?.missingIps).toEqual(['198.51.100.10']);
    expect(r.healthy).toBe(false);
  });

  it('one address unanswered does not hide a real failure on another', async () => {
    const r = await probeDeliverability(makeDeps({
      serverNodeIps: ['198.51.100.10', '198.51.100.11'],
      resolveAddresses: async () => ({ a: ['198.51.100.10', '198.51.100.11'], aaaa: [] }),
      resolvePtr: async (ip) => {
        if (ip === '198.51.100.10') throw dnsError('ETIMEOUT');
        return ['static-198-51-100-11.isp.example.net'];
      },
    }));
    expect(r.reverseDns.map((p) => p.severity)).toEqual(['skipped', 'fail']);
    expect(r.healthy).toBe(false);
  });
});

// SERVFAIL is the one error that IS an answer: the resolver replied that the
// zone's own name servers gave it nothing. Receivers asking the same resolvers
// see the same, so it must keep counting against deliverability — skipping it
// would have made a broken delegation or a dead authoritative server silent.
describe('SERVFAIL counts against deliverability', () => {
  it('isServfailError: by code, or by its words when there is no code', () => {
    expect(isServfailError(dnsError('ESERVFAIL'))).toBe(true);
    expect(isServfailError(new Error('SERVFAIL'))).toBe(true);
    expect(isServfailError(new Error('queryA ESERVFAIL mail.example.com'))).toBe(true);
    for (const code of ['ETIMEOUT', 'ENOTFOUND', 'ENODATA', 'EREFUSED', 'ECONNREFUSED']) {
      expect(isServfailError(dnsError(code))).toBe(false);
    }
    expect(isServfailError(new Error('Forward DNS lookup for mail.example.com timed out'))).toBe(false);
    expect(isServfailError(null)).toBe(false);
    // The code wins over a message that merely mentions it.
    const e = new Error('retry after SERVFAIL');
    (e as NodeJS.ErrnoException).code = 'ETIMEOUT';
    expect(isServfailError(e)).toBe(false);
  });

  it('forward DNS: SERVFAIL is a failure, worded as what it is — not as a missing record', async () => {
    const r = await probeDeliverability(makeDeps({ resolveAddresses: async () => { throw dnsError('ESERVFAIL', 'queryA'); } }));
    expect(r.forwardDns?.severity).toBe('fail');
    expect(r.forwardDns?.actual).toMatch(/^resolvers answered SERVFAIL: /);
    expect(r.forwardDns?.remediation).toMatch(/name servers/);
    expect(r.forwardDns?.remediation).not.toMatch(/Add A record/);
    // Nothing is known about which addresses are published.
    expect(r.forwardDns?.missingIps).toEqual([]);
    expect(r.healthy).toBe(false);
  });

  it('reverse DNS: SERVFAIL fails for IPv4 and warns for IPv6, like a missing PTR', async () => {
    const r = await probeDeliverability(makeDeps({
      serverNodeIps: ['198.51.100.10'],
      serverNodeIpv6s: ['2001:db8:9::10'],
      resolveAddresses: async () => ({ a: ['198.51.100.10'], aaaa: ['2001:db8:9::10'] }),
      resolvePtr: async () => { throw dnsError('ESERVFAIL'); },
    }));
    expect(r.reverseDns.map((p) => p.severity)).toEqual(['fail', 'warning']);
    expect(r.reverseDns[0].actual).toMatch(/^resolvers answered SERVFAIL: /);
    expect(r.reverseDns[0].remediation).toMatch(/reverse zone belongs to the IP's network provider/);
    expect(r.reverseDns[0].remediation).not.toMatch(/No PTR record/);
    expect(r.healthy).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// The second resolver has to be reached INSIDE the lookup budget
// ─────────────────────────────────────────────────────────────────────
//
// Measured on production: with 1.1.1.1 silent, the answer from 8.8.8.8 arrived
// after 3023 ms — the lookup gives up at 3000. Two real UDP sockets on
// localhost: the first swallows every query, the second answers.

/** A minimal DNS answer to a PTR question: the question echoed, one PTR record. */
function ptrAnswer(query: Buffer, target: string): Buffer {
  let end = 12;
  while (query[end] !== 0) end += query[end]! + 1;
  end += 5; // root label + QTYPE + QCLASS
  const header = Buffer.from(query.subarray(0, 12));
  header.writeUInt16BE(0x8180, 2); // response, recursion desired + available, no error
  header.writeUInt16BE(1, 4);      // QDCOUNT
  header.writeUInt16BE(1, 6);      // ANCOUNT
  header.writeUInt16BE(0, 8);      // NSCOUNT
  header.writeUInt16BE(0, 10);     // ARCOUNT — the query's EDNS record is not echoed
  const name = Buffer.concat([...target.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
  const record = Buffer.alloc(12);
  record.writeUInt16BE(0xc00c, 0); // the name asked for
  record.writeUInt16BE(12, 2);     // PTR
  record.writeUInt16BE(1, 4);      // IN
  record.writeUInt32BE(60, 6);     // TTL
  record.writeUInt16BE(name.length, 10);
  return Buffer.concat([header, query.subarray(12, end), record, name]);
}

const bound = (socket: dgram.Socket): Promise<number> => new Promise((resolve, reject) => {
  socket.once('error', reject);
  socket.bind(0, '127.0.0.1', () => resolve(socket.address().port));
});

describe('resolverFor — fails over to the next resolver inside the lookup budget', () => {
  it('answers from the second resolver well under 3 s when the first never replies', async () => {
    const silent = dgram.createSocket('udp4');
    const answering = dgram.createSocket('udp4');
    let swallowed = 0;
    silent.on('message', () => { swallowed += 1; });
    answering.on('message', (msg, from) => { answering.send(ptrAnswer(msg, 'mail.example.test'), from.port, from.address); });
    try {
      const [silentPort, answeringPort] = await Promise.all([bound(silent), bound(answering)]);
      const resolver = resolverFor([`127.0.0.1:${silentPort}`, `127.0.0.1:${answeringPort}`]);
      const started = performance.now();
      const names = await resolver.reverse('198.51.100.10');
      const took = performance.now() - started;
      expect(names).toEqual(['mail.example.test']);
      // The first resolver really was asked and really said nothing...
      expect(swallowed).toBeGreaterThanOrEqual(1);
      // ...so the answer cannot have come sooner than its one-second turn,
      // and it came with time to spare before the 3 s budget.
      expect(took).toBeGreaterThan(800);
      expect(took).toBeLessThan(2_500);
    } finally {
      silent.close();
      answering.close();
    }
  }, 10_000);

  it('answers at once when the first resolver replies', async () => {
    const answering = dgram.createSocket('udp4');
    answering.on('message', (msg, from) => { answering.send(ptrAnswer(msg, 'mail.example.test'), from.port, from.address); });
    try {
      const port = await bound(answering);
      const started = performance.now();
      expect(await resolverFor([`127.0.0.1:${port}`, '192.0.2.1']).reverse('198.51.100.10')).toEqual(['mail.example.test']);
      expect(performance.now() - started).toBeLessThan(500);
    } finally {
      answering.close();
    }
  }, 10_000);
});


import { describe, it, expect, vi, beforeEach } from 'vitest';
import { banRefusal, parseBanTarget } from './ban-safety.js';

const ctx = {
  operatorIp: '198.51.100.20',
  platformAddresses: ['203.0.113.10', '2001:db8:aa::10'],
  trustedRanges: ['198.51.100.128/25'],
};

describe('banRefusal', () => {
  it.each([
    ['203.0.113.99'],
    ['203.0.113.64/28'],         // nowhere near .10 / .30
    ['2001:db8:bb::1'],
    ['198.51.100.21'],
  ])('allows a public address that is nobody on the platform: %s', (v) => {
    expect(banRefusal(v, ctx)).toBeNull();
  });

  it.each([
    ['198.51.100.20', /your own address/],
    ['198.51.100.0/27', /your own address/],                // range covering the operator
    ['203.0.113.10', /platform's own nodes or ingress/],
    ['203.0.113.0/24', /platform's own nodes or ingress/],
    ['2001:db8:aa::/48', /platform's own nodes or ingress/],
    ['::ffff:203.0.113.10', /platform's own nodes or ingress/],
    ['10.42.1.7', /private, loopback/],
    ['172.20.0.0/16', /private, loopback/],
    ['192.168.1.1', /private, loopback/],
    ['100.64.0.1', /private, loopback/],                    // CGNAT
    ['127.0.0.1', /private, loopback/],
    ['169.254.10.1', /private, loopback/],
    ['0.0.0.0/0', /your own address/],                      // everything
    ['::1', /private, loopback/],
    ['fd00::1', /private, loopback/],
    ['fe80::1', /private, loopback/],
    ['198.51.100.200', /trusted range/],
  ])('refuses %s', (v, why) => {
    const r = banRefusal(v, ctx);
    expect(r?.code).toBe('BAN_TARGET_PROTECTED');
    expect(r?.message).toMatch(why);
  });

  it.each(['not-an-ip', '203.0.113.1/33', '203.0.113.1/24/1', '2001:db8::1/129', '203.0.113.1/abc'])(
    'rejects malformed input: %s', (v) => {
      expect(banRefusal(v, ctx)?.code).toBe('BAN_TARGET_INVALID');
    });

  it('parses IPv4-mapped IPv6 as the IPv4 it maps', () => {
    expect(parseBanTarget('::ffff:203.0.113.5')).toEqual({ network: '203.0.113.5', prefix: 32, family: 'ipv4' });
  });
});

// ── the loader: fails closed ──
const resolveTrustSources = vi.fn();
const isIpInAllowlist = vi.fn();
const listAllowlistEntries = vi.fn();
vi.mock('./crowdsec-l4.js', () => ({ resolveTrustSources: (...a: unknown[]) => resolveTrustSources(...a) }));
vi.mock('./crowdsec-allowlists.js', () => ({
  isIpInAllowlist: (...a: unknown[]) => isIpInAllowlist(...a),
  listAllowlistEntries: (...a: unknown[]) => listAllowlistEntries(...a),
}));
vi.mock('../ingress-routes/service.js', () => ({
  getIngressSettings: async () => ({ ingressDefaultIpv4: '203.0.113.30', ingressDefaultIpv6: null }),
  parseIngressIps: (raw: string | null) => (raw ? raw.split(',') : []),
}));

describe('checkBanAllowed', () => {
  const deps = { db: {} as never, kubeconfigPath: undefined };
  beforeEach(() => {
    vi.clearAllMocks();
    resolveTrustSources.mockResolvedValue({ trustedRangesV4: [], trustedRangesV6: [], clusterPeersV4: ['203.0.113.10'], clusterPeersV6: [] });
    isIpInAllowlist.mockResolvedValue(false);
    listAllowlistEntries.mockResolvedValue([]);
  });
  const check = async (v: string, op: string | null = null) => (await import('./ban-safety-context.js')).checkBanAllowed(deps, v, op);

  it('allows an ordinary public address', async () => {
    expect(await check('198.51.100.7')).toBeNull();
  });

  it('refuses the configured ingress address', async () => {
    expect((await check('203.0.113.30'))?.message).toMatch(/nodes or ingress/);
  });

  it('refuses when the node list cannot be read (fail closed)', async () => {
    resolveTrustSources.mockResolvedValue({ trustedRangesV4: [], trustedRangesV6: [], clusterPeersV4: [], clusterPeersV6: [] });
    expect((await check('198.51.100.7'))?.message).toMatch(/Could not read the cluster's node addresses/);
  });

  it('refuses an allowlisted address (and one the allowlist check could not clear)', async () => {
    isIpInAllowlist.mockResolvedValue(true);
    expect((await check('198.51.100.7'))?.message).toMatch(/allowlist/);
  });

  it('refuses a range that overlaps an allowlist entry; a failed listing refuses too', async () => {
    listAllowlistEntries.mockResolvedValue([{ value: '198.51.100.64/26', scope: 'Range', comment: 'x' }]);
    expect((await check('198.51.100.0/24'))?.message).toMatch(/overlaps the allowlisted 198\.51\.100\.64\/26/);
    listAllowlistEntries.mockRejectedValue(new Error('lapi down'));
    expect((await check('198.51.100.0/24'))?.message).toMatch(/could not be checked/);
  });
});

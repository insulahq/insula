import { describe, it, expect } from 'vitest';
import type { TrustSources } from './crowdsec-l4.js';
import {
  isReliableSource,
  suggestedCidrForIp,
  operatorRangeName,
  buildOperatorTrustStatus,
} from './operator-trust.js';

const EMPTY: TrustSources = { trustedRangesV4: [], trustedRangesV6: [], clusterPeersV4: [], clusterPeersV6: [] };
const K8S_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

describe('isReliableSource', () => {
  it('trusts ONLY the Traefik-set, unspoofable x-real-ip', () => {
    expect(isReliableSource('x-real-ip')).toBe(true);
  });
  it('rejects client-controllable x-forwarded-for, the proxy IP (req-ip), and none', () => {
    expect(isReliableSource('x-forwarded-for')).toBe(false); // client-spoofable → not for firewall whitelisting
    expect(isReliableSource('req-ip')).toBe(false);
    expect(isReliableSource('none')).toBe(false);
  });
});

describe('suggestedCidrForIp', () => {
  it('host-routes IPv4 as /32 and IPv6 as /128', () => {
    expect(suggestedCidrForIp('203.0.113.7')).toBe('203.0.113.7/32');
    expect(suggestedCidrForIp('2001:db8::1')).toBe('2001:db8::1/128');
  });
  it('returns null for a non-IP or null', () => {
    expect(suggestedCidrForIp('not-an-ip')).toBeNull();
    expect(suggestedCidrForIp(null)).toBeNull();
    expect(suggestedCidrForIp('')).toBeNull();
  });
});

describe('operatorRangeName', () => {
  it('produces a k8s-name-safe name for IPv4', () => {
    const n = operatorRangeName('203.0.113.7');
    expect(n).toBe('op-203-0-113-7');
    expect(n).toMatch(K8S_NAME);
  });
  it('produces a valid name for IPv6 (no leading/trailing/colon chars, <=63)', () => {
    const n = operatorRangeName('2001:db8::1');
    expect(n).toMatch(K8S_NAME);
    expect(n.length).toBeLessThanOrEqual(63);
    expect(n.startsWith('op-')).toBe(true);
  });
  it('a fully-expanded IPv6 stays within the 63-char k8s limit and stays valid', () => {
    const n = operatorRangeName('2001:0db8:0000:0000:0000:0000:0000:0001');
    expect(n).toMatch(K8S_NAME);
    expect(n.length).toBeLessThanOrEqual(63);
  });
  it('truncates to 63 chars and never leaves a trailing hyphen (defensive path)', () => {
    // Not a real IP, but exercises the slice(0,63)+strip-trailing-hyphen branch.
    const n = operatorRangeName('a'.repeat(100) + ':::');
    expect(n.length).toBeLessThanOrEqual(63);
    expect(n).toMatch(K8S_NAME);
    expect(n.endsWith('-')).toBe(false);
  });
});

describe('buildOperatorTrustStatus', () => {
  it('untrusted IP via x-real-ip → canAdd with suggestions', () => {
    const s = buildOperatorTrustStatus('203.0.113.7', 'x-real-ip', EMPTY);
    expect(s.isTrusted).toBe(false);
    expect(s.canAdd).toBe(true);
    expect(s.suggestedCidr).toBe('203.0.113.7/32');
    expect(s.suggestedName).toBe('op-203-0-113-7');
  });

  it('trusted IP (inside a range) → isTrusted, never offers add', () => {
    const s = buildOperatorTrustStatus('10.8.0.5', 'x-real-ip', { ...EMPTY, trustedRangesV4: ['10.8.0.0/24'] });
    expect(s.isTrusted).toBe(true);
    expect(s.canAdd).toBe(false);
  });

  it('trusted IP (a cluster peer) → isTrusted', () => {
    const s = buildOperatorTrustStatus('10.0.0.3', 'x-real-ip', { ...EMPTY, clusterPeersV4: ['10.0.0.3'] });
    expect(s.isTrusted).toBe(true);
    expect(s.canAdd).toBe(false);
  });

  it('untrusted but only the proxy IP (req-ip) → no add offered', () => {
    const s = buildOperatorTrustStatus('10.42.0.9', 'req-ip', EMPTY);
    expect(s.isTrusted).toBe(false);
    expect(s.canAdd).toBe(false); // can't whitelist the proxy/pod IP
  });

  it('untrusted via x-forwarded-for (client-spoofable) → no add offered, IP still shown', () => {
    const s = buildOperatorTrustStatus('203.0.113.7', 'x-forwarded-for', EMPTY);
    expect(s.isTrusted).toBe(false);
    expect(s.canAdd).toBe(false);
    expect(s.suggestedCidr).toBe('203.0.113.7/32');
  });

  it('a non-IP string yields null suggestions and no add', () => {
    const s = buildOperatorTrustStatus('not-an-ip', 'x-real-ip', EMPTY);
    expect(s.suggestedCidr).toBeNull();
    expect(s.suggestedName).toBeNull();
    expect(s.canAdd).toBe(false);
  });

  it('undeterminable IP (source none) → safe null status', () => {
    const s = buildOperatorTrustStatus(null, 'none', EMPTY);
    expect(s.isTrusted).toBe(false);
    expect(s.canAdd).toBe(false);
    expect(s.suggestedCidr).toBeNull();
    expect(s.suggestedName).toBeNull();
  });

  it('IPv6 untrusted via x-real-ip → /128 suggestion + canAdd', () => {
    const s = buildOperatorTrustStatus('2001:db8::1', 'x-real-ip', EMPTY);
    expect(s.canAdd).toBe(true);
    expect(s.suggestedCidr).toBe('2001:db8::1/128');
  });
});

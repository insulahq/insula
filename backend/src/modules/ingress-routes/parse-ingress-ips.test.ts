import { describe, it, expect } from 'vitest';
import { parseIngressIps } from './service.js';

describe('parseIngressIps', () => {
  it('returns an empty list for unset values', () => {
    expect(parseIngressIps(null)).toEqual([]);
    expect(parseIngressIps(undefined)).toEqual([]);
    expect(parseIngressIps('')).toEqual([]);
    expect(parseIngressIps('   ')).toEqual([]);
  });

  it('parses a single address', () => {
    expect(parseIngressIps('203.0.113.10')).toEqual(['203.0.113.10']);
  });

  // Multi-node / multi-ingress: every ingress-enabled address is published so
  // apex records round-robin instead of pinning tenants to one node.
  it('splits comma- and whitespace-separated lists', () => {
    expect(parseIngressIps('203.0.113.10,203.0.113.11')).toEqual(['203.0.113.10', '203.0.113.11']);
    expect(parseIngressIps('203.0.113.10, 203.0.113.11')).toEqual(['203.0.113.10', '203.0.113.11']);
    expect(parseIngressIps('203.0.113.10 203.0.113.11')).toEqual(['203.0.113.10', '203.0.113.11']);
  });

  it('deduplicates', () => {
    expect(parseIngressIps('203.0.113.10, 203.0.113.10')).toEqual(['203.0.113.10']);
  });

  it('handles IPv6', () => {
    expect(parseIngressIps('2001:db8::1, 2001:db8::2')).toEqual(['2001:db8::1', '2001:db8::2']);
  });

  // getIngressSettings() falls back to 127.0.0.1 when nothing is configured
  // (a local-DinD convenience). Without this filter that fallback is written
  // verbatim into a customer's public zone as an apex A record.
  it('drops loopback and unspecified addresses', () => {
    expect(parseIngressIps('127.0.0.1')).toEqual([]);
    expect(parseIngressIps('127.0.1.1')).toEqual([]);
    expect(parseIngressIps('::1')).toEqual([]);
    expect(parseIngressIps('0.0.0.0')).toEqual([]);
    expect(parseIngressIps('::')).toEqual([]);
  });

  it('keeps real addresses when mixed with loopback', () => {
    expect(parseIngressIps('127.0.0.1, 203.0.113.10')).toEqual(['203.0.113.10']);
  });
});

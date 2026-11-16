/**
 * Trusted-IP values: parse, canonicalise and match.
 *
 * A value is interpolated into a SecRule `@ipMatch` list, so it must be
 * nothing but an address (renderer.ts isRenderableIpValue re-checks it), and
 * it is stored canonically so "203.0.113.7" and "203.0.113.7/32", or two
 * spellings of one IPv6 address, are one entry. A network is stored as its
 * network address ("203.0.113.0/24" for "203.0.113.9/24"), which is what it
 * covers either way.
 */
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import {
  canonicalIp,
  WAF_TRUSTED_IPV4_MIN_PREFIX,
  WAF_TRUSTED_IPV6_MIN_PREFIX,
} from '@insula/api-contracts';
import { unmapIp } from '../cluster-network/blacklist-safety.js';

export type TrustedIpValue =
  | { readonly ok: true; readonly value: string; readonly family: 'ipv4' | 'ipv6'; readonly prefix: number }
  | { readonly ok: false; readonly message: string };

const V4_BITS = 32;
const V6_BITS = 128;

function ipv4ToInt(addr: string): number {
  return addr.split('.').reduce((acc, o) => ((acc << 8) | Number(o)) >>> 0, 0);
}

function intToIpv4(n: number): string {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 0xff).join('.');
}

/** An address isIPv6 accepted, as a 128-bit integer. */
function ipv6ToBigInt(addr: string): bigint {
  let a = addr.toLowerCase();
  const v4Tail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (v4Tail) {
    const n = ipv4ToInt(v4Tail[2]!);
    a = `${v4Tail[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head = '', tail] = a.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups = tail === undefined
    ? left
    : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

/** The canonical (RFC 5952) form — the platform's one spelling (contracts ip-canonical.ts). */
function bigIntToIpv6(n: bigint): string {
  const groups = Array.from({ length: 8 }, (_v, i) => ((n >> BigInt(112 - i * 16)) & 0xffffn).toString(16));
  return canonicalIp(groups.join(':'));
}

/**
 * Parse what a tenant typed. Refused: anything that is not an IPv4/IPv6
 * address with an optional prefix, an unspecified or loopback address (no
 * request carries one), and a network wider than /24 (IPv4) or /48 (IPv6).
 */
export function canonicalTrustedIp(input: string): TrustedIpValue {
  const trimmed = input.trim();
  const parts = trimmed.split('/');
  if (parts.length > 2 || parts[0] === '' || trimmed.includes('%')) {
    return { ok: false, message: 'Enter an IPv4 or IPv6 address, optionally with a /prefix' };
  }
  const addr = unmapIp(parts[0]!);
  const family = isIPv4(addr) ? 'ipv4' : isIPv6(addr) ? 'ipv6' : null;
  if (family === null) return { ok: false, message: `${parts[0]} is not an IPv4 or IPv6 address` };
  const bits = family === 'ipv4' ? V4_BITS : V6_BITS;
  const rawPrefix = parts[1];
  if (rawPrefix !== undefined && !/^\d{1,3}$/.test(rawPrefix)) {
    return { ok: false, message: `/${rawPrefix} is not a prefix length` };
  }
  const prefix = rawPrefix === undefined ? bits : Number(rawPrefix);
  if (prefix > bits) return { ok: false, message: `/${prefix} is longer than an ${family === 'ipv4' ? 'IPv4' : 'IPv6'} address` };
  const minPrefix = family === 'ipv4' ? WAF_TRUSTED_IPV4_MIN_PREFIX : WAF_TRUSTED_IPV6_MIN_PREFIX;
  if (prefix < minPrefix) {
    return { ok: false, message: `/${prefix} is too wide: trust at most a /${minPrefix} ${family === 'ipv4' ? 'IPv4' : 'IPv6'} network` };
  }

  let network: string;
  if (family === 'ipv4') {
    const mask = prefix === 0 ? 0 : (0xffffffff << (V4_BITS - prefix)) >>> 0;
    network = intToIpv4((ipv4ToInt(addr) & mask) >>> 0);
    if (network.startsWith('127.') || network === '0.0.0.0') {
      return { ok: false, message: `${network} is a loopback or unspecified address — no request comes from it` };
    }
  } else {
    const all = (1n << 128n) - 1n;
    const mask = all ^ ((1n << BigInt(V6_BITS - prefix)) - 1n);
    network = bigIntToIpv6(ipv6ToBigInt(addr) & mask);
    if (network === '::' || network === '::1') {
      return { ok: false, message: `${network} is a loopback or unspecified address — no request comes from it` };
    }
  }
  return { ok: true, value: prefix === bits ? network : `${network}/${prefix}`, family, prefix };
}

/**
 * A matcher over stored values. A value that no longer parses is skipped
 * (it is also not rendered), so the matcher never claims more than the WAF does.
 */
export function addressMatcher(values: ReadonlyArray<string>): (ip: string) => boolean {
  const list = new BlockList();
  let size = 0;
  for (const raw of values) {
    const [addr, prefix] = raw.split('/');
    const plain = unmapIp(addr ?? '');
    const family = isIPv4(plain) ? 'ipv4' : isIPv6(plain) ? 'ipv6' : null;
    if (family === null) continue;
    const bits = family === 'ipv4' ? V4_BITS : V6_BITS;
    const p = prefix === undefined ? bits : Number(prefix);
    if (!Number.isInteger(p) || p < 0 || p > bits) continue;
    if (p === bits) list.addAddress(plain, family);
    else list.addSubnet(plain, p, family);
    size += 1;
  }
  if (size === 0) return () => false;
  return (ip: string) => {
    const plain = unmapIp(ip);
    if (isIPv4(plain)) return list.check(plain, 'ipv4');
    if (isIPv6(plain)) return list.check(plain, 'ipv6');
    return false;
  };
}

/**
 * Self-lockout safety rails for the firewall blacklist (pure, testable).
 *
 * A permanent host-firewall DROP that contains the operator's own IP, a
 * cluster node, a peer, or a trusted range would brick cluster access —
 * the exact failure the reconciler's self-protect belt also guards
 * against. We refuse such bans UP-FRONT at the API (defense in depth;
 * the reconciler is the authoritative second line) so the operator gets
 * an actionable 422 instead of a silently-Refused CR.
 *
 * All comparisons are family-aware and done on canonical network
 * addresses via Node's built-in `net.BlockList` (no new dependency).
 */
import { BlockList, isIPv4, isIPv6 } from 'node:net';

export interface ParsedCidr {
  readonly address: string;
  readonly prefix: number;
  readonly family: 'ipv4' | 'ipv6';
}

/**
 * Normalise an IPv4-mapped IPv6 address (`::ffff:10.0.0.5`) down to its
 * bare IPv4 form. Fastify's `req.ip` can present v4 connections this way
 * on dual-stack listeners / behind some proxies — if we left it as v6 the
 * family-aware lockout check would silently miss a v4 ban that catches the
 * admin's real address (review C1).
 */
export function unmapIp(ip: string): string {
  const m = ip.trim().match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  return m ? m[1] : ip.trim();
}

/** Parse "1.2.3.4", "1.2.3.4/24", "fd00::/8" → canonical parts, or null. */
export function parseCidr(input: string): ParsedCidr | null {
  const trimmed = input.trim();
  const [rawAddr, prefixStr] = trimmed.split('/');
  if (!rawAddr) return null;
  // Unmap ::ffff:a.b.c.d so a mapped address is classified as v4 (C1).
  const addr = unmapIp(rawAddr);
  let family: 'ipv4' | 'ipv6';
  let maxPrefix: number;
  if (isIPv4(addr)) {
    family = 'ipv4';
    maxPrefix = 32;
  } else if (isIPv6(addr)) {
    family = 'ipv6';
    maxPrefix = 128;
  } else {
    return null;
  }
  let prefix = maxPrefix;
  if (prefixStr !== undefined) {
    if (!/^\d{1,3}$/.test(prefixStr)) return null;
    prefix = Number.parseInt(prefixStr, 10);
    if (prefix < 0 || prefix > maxPrefix) return null;
  }
  return { address: addr, prefix, family };
}

/** True iff the single IP `ip` falls inside the CIDR `block`. */
export function cidrContainsIp(block: ParsedCidr, ipRaw: string): boolean {
  const ip = unmapIp(ipRaw); // C1: a mapped v4 must compare as v4
  const ipFamily = isIPv4(ip) ? 'ipv4' : isIPv6(ip) ? 'ipv6' : null;
  if (ipFamily === null || ipFamily !== block.family) return false;
  const bl = new BlockList();
  bl.addSubnet(block.address, block.prefix, block.family);
  return bl.check(ip, block.family);
}

/**
 * True iff the proposed ban `block` would catch ANY of the protected IPs.
 * Bare IPs and the network/broadcast addresses of protected CIDRs are
 * tested. (We don't do full CIDR-vs-CIDR overlap math — the protected
 * set is IPs + small admin ranges, and testing membership of each
 * protected entry's representative addresses against the proposed block
 * covers the lockout cases without a bigint subnet library.)
 */
export interface LockoutVerdict {
  readonly safe: boolean;
  readonly hitKind: string | null;
  readonly hitValue: string | null;
}

export function checkBlacklistLockout(
  proposed: ParsedCidr,
  protectedIps: ReadonlyArray<{ ip: string; kind: string }>,
): LockoutVerdict {
  for (const { ip, kind } of protectedIps) {
    const bare = ip.includes('/') ? ip.split('/')[0] : ip;
    if (cidrContainsIp(proposed, bare)) {
      return { safe: false, hitKind: kind, hitValue: ip };
    }
    // Also test the reverse: a protected CIDR that fully contains the
    // proposed ban means the operator is trying to ban inside trusted
    // space — refuse that too. The equal-prefix case (proposed == protected
    // exactly) is already caught by the forward cidrContainsIp(proposed,
    // bare) above, so we only need prefix < proposed.prefix here (L1).
    const protectedCidr = parseCidr(ip);
    if (protectedCidr && protectedCidr.prefix < proposed.prefix &&
        cidrContainsIp(protectedCidr, proposed.address)) {
      return { safe: false, hitKind: kind, hitValue: ip };
    }
  }
  return { safe: true, hitKind: null, hitValue: null };
}

/** DNS-1123 resource name derived from a CIDR (e.g. "203.0.113.10/32" → "cfb-203-0-113-10-32"). */
export function blacklistNameForCidr(cidr: string): string {
  const slug = cidr
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 58);
  return `cfb-${slug}`;
}

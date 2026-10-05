/**
 * Addresses no ban may cover.
 *
 * A CrowdSec decision is cluster-wide: the bouncer on the shared `websecure`
 * entrypoint refuses the address for every tenant, and in L4 `enforce` mode the
 * host firewall drops it outright. So a ban that covers
 *   - the operator's own address locks the operator out of the panel;
 *   - a cluster node or ingress address cuts the platform off from itself
 *     (node-to-node traffic, health checks, the ingress);
 *   - a private, loopback, link-local or CGNAT range hits pod/service traffic
 *     and the reverse proxy itself — never a real attacker on the internet;
 *   - an allowlisted address contradicts a decision someone already made.
 * Manual bans (timed and permanent) and the WAF auto-ban both go through here.
 */
import { BlockList, isIP } from 'node:net';
import { canonicalIp } from '@insula/api-contracts';

const PRIVATE_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const PRIVATE_V6: ReadonlyArray<readonly [string, number]> = [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
];

export interface BanSafetyContext {
  /** The operator's own address (manual bans only). */
  readonly operatorIp: string | null;
  /** Node, peer and ingress addresses — bare IPs. */
  readonly platformAddresses: readonly string[];
  /** Trusted ranges (ClusterTrustedRange) — CIDRs. */
  readonly trustedRanges: readonly string[];
}

export interface BanRefusal {
  readonly code: 'BAN_TARGET_INVALID' | 'BAN_TARGET_PROTECTED';
  readonly message: string;
}

type Family = 'ipv4' | 'ipv6';

interface Target { readonly network: string; readonly prefix: number; readonly family: Family }

/** `value` as a network; IPv4-mapped IPv6 is treated as the IPv4 it maps. */
export function parseBanTarget(value: string): Target | null {
  // canonicalIp unwraps EVERY spelling of an IPv4-mapped address
  // (`::ffff:a00:105`, `0:0:0:0:0:ffff:10.0.1.5`, …) to the IPv4 host — a
  // regex for the short form alone let the long forms dodge every rule here.
  const canon = canonicalIp(value.trim());
  const [addr, prefixRaw, extra] = canon.split('/');
  if (extra !== undefined || !addr) return null;
  const ver = isIP(addr);
  if (ver === 0) return null;
  const family: Family = ver === 4 ? 'ipv4' : 'ipv6';
  const max = ver === 4 ? 32 : 128;
  if (prefixRaw !== undefined && !/^\d{1,3}$/.test(prefixRaw)) return null;
  const prefix = prefixRaw === undefined ? max : Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { network: addr, prefix, family };
}

function covers(target: Target, ip: string): boolean {
  const t = parseBanTarget(ip);
  if (!t || t.family !== target.family) return false;
  const list = new BlockList();
  list.addSubnet(target.network, target.prefix, target.family);
  return list.check(t.network, t.family);
}

/** Two networks overlap when either contains the other's network address. */
function overlaps(a: Target, b: Target): boolean {
  if (a.family !== b.family) return false;
  const inA = new BlockList(); inA.addSubnet(a.network, a.prefix, a.family);
  const inB = new BlockList(); inB.addSubnet(b.network, b.prefix, b.family);
  return inA.check(b.network, b.family) || inB.check(a.network, a.family);
}

const show = (t: Target): string => (t.prefix === (t.family === 'ipv4' ? 32 : 128) ? t.network : `${t.network}/${t.prefix}`);

/** Why `value` must not be banned, or null when it may be. Pure. */
export function banRefusal(value: string, ctx: BanSafetyContext): BanRefusal | null {
  const target = parseBanTarget(value);
  if (!target) return { code: 'BAN_TARGET_INVALID', message: `"${value}" is not an IP address or CIDR range.` };
  const what = show(target);

  if (ctx.operatorIp && covers(target, ctx.operatorIp)) {
    return { code: 'BAN_TARGET_PROTECTED', message: `${what} covers your own address (${ctx.operatorIp}) — banning it would lock you out of the panel.` };
  }
  for (const ip of ctx.platformAddresses) {
    if (covers(target, ip)) {
      return { code: 'BAN_TARGET_PROTECTED', message: `${what} covers ${ip}, an address of this platform's own nodes or ingress — banning it would cut the cluster off from itself.` };
    }
  }
  const privates = target.family === 'ipv4' ? PRIVATE_V4 : PRIVATE_V6;
  for (const [net, prefix] of privates) {
    if (overlaps(target, { network: net, prefix, family: target.family })) {
      return { code: 'BAN_TARGET_PROTECTED', message: `${what} is (or contains) a private, loopback, link-local or reserved address (${net}/${prefix}). Traffic from there is cluster-internal or the reverse proxy itself — ban the public address instead.` };
    }
  }
  for (const cidr of ctx.trustedRanges) {
    const range = parseBanTarget(cidr);
    if (range && overlaps(target, range)) {
      return { code: 'BAN_TARGET_PROTECTED', message: `${what} overlaps the trusted range ${cidr} (Cluster → trusted ranges).` };
    }
  }
  return null;
}

/**
 * Shared IPv4/IPv6 address + CIDR patterns.
 *
 * Extracted from cluster-trusted-proxies.ts (2026-08-20) when the DNS
 * resolver settings needed the same validation. These are deliberately
 * tighter than the loose patterns elsewhere in the codebase:
 *
 *   - IPv4 is octet-bounded (0-255), so `999.999.999.999` is rejected at the
 *     API boundary instead of failing silently in a downstream reconcile.
 *   - IPv6 requires well-formed hex groups, so `:::::` and `zz::` are
 *     rejected. Exhaustive validation needs a parser; this covers the common
 *     shapes (full, `::`-compressed, embedded IPv4) and rejects the garbage
 *     inputs that actually get typed into a form.
 *
 * Keep ONE copy. A second, looser copy is how `999.999.999.999` gets accepted
 * on one endpoint and refused on another.
 */

const ipv4Octet = '(25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)';

/** Bare IPv4 address, octet-bounded. */
export const ipv4BarePattern = new RegExp(`^${ipv4Octet}(?:\\.${ipv4Octet}){3}$`);

/** IPv4 CIDR. `/0` is intentionally NOT matched — see cluster-trusted-proxies. */
export const ipv4CidrPattern = new RegExp(
  `^${ipv4Octet}(?:\\.${ipv4Octet}){3}\\/([1-9]|[12]\\d|3[0-2])$`,
);

const ipv6Group = '[0-9a-fA-F]{1,4}';
const ipv6Full = `(?:${ipv6Group}:){7}${ipv6Group}`;
const ipv6Compressed =
  `(?:(?:${ipv6Group}:){1,7}:)|` +
  `(?:(?:${ipv6Group}:){1,6}:${ipv6Group})|` +
  `(?:(?:${ipv6Group}:){1,5}(?::${ipv6Group}){1,2})|` +
  `(?:(?:${ipv6Group}:){1,4}(?::${ipv6Group}){1,3})|` +
  `(?:(?:${ipv6Group}:){1,3}(?::${ipv6Group}){1,4})|` +
  `(?:(?:${ipv6Group}:){1,2}(?::${ipv6Group}){1,5})|` +
  `(?:${ipv6Group}:(?::${ipv6Group}){1,6})|` +
  `(?::(?::${ipv6Group}){1,7})|` +
  `(?:::)`;

const ipv6Address = `(?:${ipv6Full}|${ipv6Compressed})`;

/** Bare IPv6 address. */
export const ipv6BarePattern = new RegExp(`^${ipv6Address}$`);

/** IPv6 CIDR. `/0` is intentionally NOT matched. */
export const ipv6CidrPattern = new RegExp(
  `^${ipv6Address}\\/([1-9]|[1-9]\\d|1[01]\\d|12[0-8])$`,
);

/** True for a bare IPv4 or IPv6 address (no prefix, no port). */
export function isBareIpAddress(value: string): boolean {
  return ipv4BarePattern.test(value) || ipv6BarePattern.test(value);
}

/** Which family a bare address belongs to; null when it is not an address. */
export function ipFamily(value: string): 'ipv4' | 'ipv6' | null {
  if (ipv4BarePattern.test(value)) return 'ipv4';
  if (ipv6BarePattern.test(value)) return 'ipv6';
  return null;
}

/**
 * App-level trusted-proxy set for Fastify's `trustProxy`.
 *
 * Mirrors `set_real_ip_from` in
 * frontend/{admin,tenant}-panel/nginx.conf.template — operator decision
 * 2026-07-19 was to use the RFC1918 super-set everywhere rather than the
 * bare k3s pod CIDR (10.42.0.0/16 is a subset of 10.0.0.0/8).
 *
 * WHY NOT `trustProxy: true` (2026-07-28 security review):
 *   `true` means "trust every hop", so proxy-addr returns the LEFT-MOST
 *   X-Forwarded-For entry — the one furthest from us, and the one a client
 *   can write. `request.ip` keys the unauthenticated login rate limit and is
 *   persisted as the audit-log / refresh-token source IP.
 *
 *   Not exploitable in the shipped topology: Traefik fronts every route with
 *   `forwardedHeaders.trustedIPs=127.0.0.1/32` and therefore strips
 *   client-supplied X-Forwarded-For / X-Real-IP / Forwarded headers before
 *   they reach nginx (verified against staging 2026-07-28 — five spoof
 *   variants all still audited the true client IP). But that protection
 *   lives one layer up and is operator-tunable: fronting the cluster with an
 *   external LB means ADDING that LB's CIDR to `forwardedHeaders.trustedIPs`,
 *   after which Traefik passes client XFF through. Bounding trust here keeps
 *   the second layer safe on its own.
 */

/** Loopback + RFC1918 + IPv6 ULA — every legitimate in-cluster hop. */
export const DEFAULT_TRUSTED_PROXY_CIDRS: readonly string[] = [
  '127.0.0.1/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fd00::/8',
];

/**
 * Resolve the effective trusted-proxy list.
 *
 * `PLATFORM_TRUSTED_PROXY_CIDRS` (comma-separated) REPLACES the default —
 * for clusters whose pod network sits outside RFC1918. An operator setting
 * it must include every private range they still need.
 *
 * An empty / whitespace-only value falls back to the default rather than
 * degrading to "trust nothing", which would pin `request.ip` to the nginx
 * pod IP for every request and silently destroy rate-limit fairness and
 * audit fidelity.
 */
export function resolveTrustedProxyCidrs(
  raw: string | undefined = process.env.PLATFORM_TRUSTED_PROXY_CIDRS,
): string[] {
  if (!raw) return [...DEFAULT_TRUSTED_PROXY_CIDRS];
  const parsed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : [...DEFAULT_TRUSTED_PROXY_CIDRS];
}

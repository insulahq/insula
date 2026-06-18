/**
 * Operator → trusted-range bridge (R11 / Phase 2.3.1).
 *
 * When the operator's CURRENT connection comes from a source IP that is not in
 * any ClusterTrustedRange (nor a cluster peer), locking down SSH / enabling L4
 * enforce would lock them out. This module surfaces that and offers a one-click
 * "add my IP to trusted ranges".
 *
 * SECURITY: the IP to whitelist is ALWAYS derived server-side from the request
 * (X-Real-IP, Traefik-set + unspoofable) — never from the request body — so the
 * endpoint can only ever trust the caller's own connection, not an arbitrary IP.
 * `canAdd` is false unless we have a reliable real-client IP (x-real-ip /
 * x-forwarded-for), so we never whitelist a proxy/pod IP (req-ip) by mistake.
 *
 * The pure helpers (name/CIDR derivation, status assembly) are unit-tested;
 * resolveTrustSources / createTrustedRange (kube-API) are integration.
 */
import { isIP } from 'node:net';
import type { OperatorTrustStatus } from '@insula/api-contracts';
import { isOperatorIpTrusted, type OperatorIpSource, type TrustSources } from './crowdsec-l4.js';

export type { OperatorTrustStatus };

/**
 * A source we trust enough to whitelist a firewall range from. ONLY
 * `x-real-ip` — it's set by Traefik and not client-spoofable. `x-forwarded-for`
 * is client-controllable (leftmost), and `req-ip` is the proxy/pod IP; offering
 * a one-click firewall whitelist off either would be unsafe, so the UI falls
 * back to "add a trusted range manually" for those.
 */
export function isReliableSource(source: OperatorIpSource): boolean {
  return source === 'x-real-ip';
}

/** `<ip>/32` for IPv4, `<ip>/128` for IPv6, null for a non-IP. */
export function suggestedCidrForIp(ip: string | null): string | null {
  if (!ip) return null;
  const ver = isIP(ip);
  if (ver === 4) return `${ip}/32`;
  if (ver === 6) return `${ip}/128`;
  return null;
}

/** Deterministic, k8s-name-safe ClusterTrustedRange name for an operator IP. */
export function operatorRangeName(ip: string): string {
  const slug = ip.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `op-${slug}`.slice(0, 63).replace(/-+$/, '');
}

export function buildOperatorTrustStatus(
  ip: string | null,
  source: OperatorIpSource,
  sources: TrustSources,
): OperatorTrustStatus {
  const isTrusted = isOperatorIpTrusted(ip, sources);
  const suggestedCidr = suggestedCidrForIp(ip);
  const suggestedName = ip && suggestedCidr ? operatorRangeName(ip) : null;
  const canAdd = !isTrusted && Boolean(suggestedCidr) && isReliableSource(source);
  return { ip, source, isTrusted, suggestedCidr, suggestedName, canAdd };
}

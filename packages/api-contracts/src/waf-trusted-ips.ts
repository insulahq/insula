/**
 * WAF trusted IPs: addresses a tenant names for ONE of its routes whose
 * requests the WAF still checks and logs but never blocks on that route's
 * hostname — the tenant's own workstation, office or automation.
 *
 * Rendered like the platform allowlist (`ctl:ruleEngine=DetectionOnly`),
 * chained behind the route's hostname, so it reaches no other site. Its
 * events are marked `trusted_ip` and do not count toward the platform's
 * auto-ban. It is not the route's IP allowlist, which decides who may reach
 * the site at all.
 *
 * A trusted address is a hole in the WAF for that site: anything sent from
 * it is not stopped. Single addresses are the norm; a network is capped at
 * /24 (IPv4) or /48 (IPv6), and a route holds at most
 * WAF_TRUSTED_IPS_PER_ROUTE_MAX entries. The server parses and canonicalises
 * the value (a network is stored as its network address); this schema only
 * screens the characters so the panel can say early what is wrong.
 */
import { z } from 'zod';

export const WAF_TRUSTED_IPS_PER_ROUTE_MAX = 20;
/** Widest IPv4 network a route may trust. */
export const WAF_TRUSTED_IPV4_MIN_PREFIX = 24;
/** Widest IPv6 network a route may trust. */
export const WAF_TRUSTED_IPV6_MIN_PREFIX = 48;
export const WAF_TRUSTED_IP_NOTE_MAX = 200;

export const wafTrustedIpSchema = z.object({
  id: z.string().uuid(),
  routeId: z.string().uuid(),
  /** Canonical address or network, e.g. `203.0.113.7` or `2001:db8:1::/48`. */
  value: z.string(),
  note: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
});
export type WafTrustedIp = z.infer<typeof wafTrustedIpSchema>;

export const wafTrustedIpListResponseSchema = z.object({
  trustedIps: z.array(wafTrustedIpSchema),
  /** Most entries the route may hold. */
  max: z.number().int(),
});
export type WafTrustedIpListResponse = z.infer<typeof wafTrustedIpListResponseSchema>;

export const createWafTrustedIpRequestSchema = z.object({
  value: z.string().trim().min(2).max(49)
    .regex(/^[0-9A-Fa-f.:]+(\/\d{1,3})?$/, 'an IPv4 or IPv6 address, optionally with a /prefix'),
  note: z.string().trim().max(WAF_TRUSTED_IP_NOTE_MAX).optional(),
});
export type CreateWafTrustedIpRequest = z.infer<typeof createWafTrustedIpRequestSchema>;

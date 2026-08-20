/**
 * Cluster DNS resolver settings.
 *
 * WHY THIS EXISTS
 * Every DNS lookup the platform makes (domain verification, mail
 * deliverability, DNS drift scans) went through whatever resolver the POD
 * happened to inherit — CoreDNS, forwarding to the node's /etc/resolv.conf,
 * which on a mesh-joined node is owned by NetBird. That path is invisible to
 * the operator, differs per node, and changes under them when the mesh agent
 * rewrites resolv.conf.
 *
 * It was also inconsistent: domain verification used the pod resolver while
 * mail deliverability had its own private `externalDnsServers()` hardcoded to
 * 1.1.1.1/8.8.8.8. Two lookups of the same name could disagree.
 *
 * These settings make the resolver an explicit, operator-visible choice:
 *
 *   host   — use the pod's inherited resolver (CoreDNS → node → mesh/hoster).
 *            The default; preserves existing behaviour.
 *   custom — use up to MAX_DNS_RESOLVER_SERVERS explicit upstreams, IPv4
 *            and/or IPv6, bypassing CoreDNS entirely.
 */

import { z } from 'zod';
import { isBareIpAddress, ipFamily } from './ip.js';

/** `host` = inherit the pod resolver; `custom` = use the configured list. */
export const DNS_RESOLVER_MODES = ['host', 'custom'] as const;
export type DnsResolverMode = (typeof DNS_RESOLVER_MODES)[number];
export const dnsResolverModeSchema = z.enum(DNS_RESOLVER_MODES);

/**
 * Four is the practical ceiling: glibc's resolver honours at most 3
 * nameservers and Node's c-ares walks the list serially on timeout, so a
 * longer list mostly buys latency on failure, not resilience.
 */
export const MAX_DNS_RESOLVER_SERVERS = 4;

/**
 * A bare IP — no port, no CIDR. Node's Resolver.setServers() accepts
 * `[v6]:port` forms too, but allowing a port here invites entries that
 * resolve fine in a unit test and time out in the cluster because the
 * NetworkPolicy only opens 53.
 */
export const dnsResolverServerSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((s) => isBareIpAddress(s), {
    message: 'must be a bare IPv4 or IPv6 address (e.g. 9.9.9.9, 2620:fe::fe) — no port, no CIDR',
  });

export const dnsResolverSettingsSchema = z
  .object({
    mode: dnsResolverModeSchema,
    servers: z.array(dnsResolverServerSchema).max(MAX_DNS_RESOLVER_SERVERS).default([]),
  })
  .superRefine((val, ctx) => {
    // `custom` with an empty list would silently fall back to the pod
    // resolver — the operator would see "custom" in the UI and get `host`
    // behaviour. Refuse it instead.
    if (val.mode === 'custom' && val.servers.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['servers'],
        message: 'custom mode requires at least one upstream server',
      });
    }
    const seen = new Set<string>();
    for (const s of val.servers) {
      const key = s.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['servers'], message: `duplicate server: ${s}` });
      }
      seen.add(key);
    }
  });

export type DnsResolverSettings = z.infer<typeof dnsResolverSettingsSchema>;

/** PUT body — same shape as the stored settings. */
export const updateDnsResolverSettingsSchema = dnsResolverSettingsSchema;
export type UpdateDnsResolverSettings = z.infer<typeof updateDnsResolverSettingsSchema>;

/**
 * Read model. `effectiveServers` is what lookups will actually use — empty in
 * `host` mode, where the resolver is whatever the pod inherited and the
 * platform genuinely does not know the addresses.
 */
export const dnsResolverStatusSchema = z.object({
  mode: dnsResolverModeSchema,
  servers: z.array(z.string()),
  effectiveServers: z.array(z.string()),
  /** Addresses the pod inherited, for display next to the `host` option. */
  hostServers: z.array(z.string()),
  maxServers: z.literal(MAX_DNS_RESOLVER_SERVERS),
});

export type DnsResolverStatus = z.infer<typeof dnsResolverStatusSchema>;

/** Split a server list by family — used by the UI to label entries. */
export function partitionByFamily(servers: readonly string[]): {
  ipv4: string[];
  ipv6: string[];
} {
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  for (const s of servers) {
    if (ipFamily(s) === 'ipv6') ipv6.push(s);
    else if (ipFamily(s) === 'ipv4') ipv4.push(s);
  }
  return { ipv4, ipv6 };
}

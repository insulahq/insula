/**
 * Mail endpoint IPs, per family — thin wrappers over resolveMailEndpoints for
 * callers that only need the flat address list (the hourly DNSBL watch).
 *
 * The names are historical: this module used to return EVERY server-role
 * node's IP. It compared the stored mode against `thisNodeOnly`, a value
 * migration 0034 renamed to `activeNodeOnly`, so the narrow branch never ran
 * again and a server node with no mail placement and no mail port exposure was
 * probed (and failed) like a mail server. The selection now lives in
 * mail-endpoints.ts, driven by placement + port-exposure mode.
 *
 * Both functions throw when the cluster or settings cannot be read, so a
 * caller can tell "could not determine" from "no endpoints".
 */

import type { Database } from '../../db/index.js';
import { endpointAddresses, resolveMailEndpoints, type MailEndpointK8s } from './mail-endpoints.js';

/** IPv4 of every mail endpoint (one per node — see mail-endpoints.ts "Addresses"). */
export async function resolveServerNodeIps(k8s: MailEndpointK8s, db: Database): Promise<string[]> {
  return endpointAddresses(await resolveMailEndpoints(k8s, db), 'ipv4');
}

/**
 * Global IPv6 of every mail endpoint. [] on a single-stack cluster, which
 * callers must treat as "nothing to check", not as a fault.
 */
export async function resolveServerNodeIpv6s(k8s: MailEndpointK8s, db: Database): Promise<string[]> {
  return endpointAddresses(await resolveMailEndpoints(k8s, db), 'ipv6');
}

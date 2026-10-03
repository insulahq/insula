import type { RouteDnsLeftovers } from './service.js';

/**
 * What a route deletion says when some of its DNS records are still published.
 *
 * Staff see why — the DNS server and the transport error are what they need to
 * fix it. A tenant sees what happened and what to do about it, never the
 * platform's DNS server or its address. Pure.
 */
export function routeDnsWarning(left: RouteDnsLeftovers, forStaff: boolean): string {
  const names = left.hostnames.map((h) => `'${h}'`).join(' and ');
  const what = `The route is removed, but the DNS records for ${names} are still published`;
  const why = forStaff ? left.reason : 'the DNS server could not withdraw them right now';
  return `${what}: ${why}. They stay listed under DNS Records — delete them there once the DNS server answers.`;
}

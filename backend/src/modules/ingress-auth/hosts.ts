/**
 * Which host a protected route's sign-in lives on.
 *
 * A route with a www redirect SERVES only its canonical form; the other form
 * answers with the redirect. The sign-in (its `/oauth2/*` endpoints, cookie and
 * redirect URI) must be on the served host: on the redirecting one, the
 * callback's CSRF cookie belongs to a host the visitor never comes back to.
 */
import { isWildcardHostname } from '@insula/api-contracts';
import { wwwRedirectHosts } from '../ingress-routes/traefik-types.js';

export type WwwRedirect = 'none' | 'add-www' | 'remove-www';

/** The host a route serves (the canonical form when it has a www redirect). Pure. */
export function servedHost(hostname: string, wwwRedirect: string | null | undefined): string {
  const mode: WwwRedirect = wwwRedirect === 'add-www' || wwwRedirect === 'remove-www' ? wwwRedirect : 'none';
  return wwwRedirectHosts(hostname, mode).canonical;
}

/** The redirect URI to register at the identity provider for that host. Pure. */
export function buildCallbackUrl(host: string): string {
  return `https://${host}/oauth2/callback`;
}

/** A wildcard route has no single host to send the identity provider back to. */
export function canProtectHost(hostname: string): boolean {
  return !isWildcardHostname(hostname);
}

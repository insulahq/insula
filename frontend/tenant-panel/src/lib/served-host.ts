/**
 * The host a route serves. With a www redirect only the canonical form serves
 * the site; the other answers with the redirect. A route's sign-in (and the
 * redirect URI registered at the identity provider) lives on the served host.
 * Mirrors backend/src/modules/ingress-auth/hosts.ts.
 */
export function servedHost(hostname: string, wwwRedirect: string | null | undefined): string {
  const host = hostname.trim().toLowerCase();
  if (host.startsWith('*.') || (wwwRedirect !== 'add-www' && wwwRedirect !== 'remove-www')) return host;
  const bare = host.startsWith('www.') ? host.slice(4) : host;
  return wwwRedirect === 'add-www' ? `www.${bare}` : bare;
}

export function isWildcardHost(hostname: string): boolean {
  return hostname.trim().startsWith('*.');
}

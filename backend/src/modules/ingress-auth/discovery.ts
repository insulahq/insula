/**
 * OpenID discovery for a tenant-supplied issuer.
 *
 * Fetched by platform-api, so through guardedFetch: an issuer URL is a
 * tenant-chosen address, and platform-api can reach the kube API, the database
 * and the cloud metadata service. Internal addresses are refused and redirects
 * are not followed. A provider on a private network can still be used — its
 * own oauth2-proxy runs in the tenant's namespace and reports what it finds
 * when it starts — it just cannot be tested from here.
 */
import { guardedFetch, SsrfBlockedError } from '../../shared/ssrf-guard.js';
import type { IngressAuthTestResponse } from '@insula/api-contracts';

const TIMEOUT_MS = 5_000;

export type Fetcher = (url: string) => Promise<{ status: number; body: string }>;
const defaultFetcher: Fetcher = (url) => guardedFetch(url, { timeoutMs: TIMEOUT_MS, maxBytes: 256 * 1024 });

/** `<issuer>/.well-known/openid-configuration`, without a doubled slash. Pure. */
export function discoveryUrl(issuerUrl: string): string {
  return `${issuerUrl.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

const empty = { issuer: null, authorizationEndpoint: null, tokenEndpoint: null, jwksUri: null } as const;

export async function discoverIssuer(issuerUrl: string, fetcher: Fetcher = defaultFetcher): Promise<IngressAuthTestResponse> {
  const trimmed = issuerUrl.trim();
  if (!/^https:\/\/[^?#\s]+$/.test(trimmed)) {
    return { ok: false, issuerReachable: false, ...empty, error: 'The issuer URL must be an https:// URL without ? or #.' };
  }
  let res: { status: number; body: string };
  try {
    res = await fetcher(discoveryUrl(trimmed));
  } catch (err) {
    const error = err instanceof SsrfBlockedError
      ? 'This address is on a private network, so it cannot be tested from here. Saving still works: the sign-in service connects to it from your namespace and reports any problem.'
      : `The provider could not be reached: ${err instanceof Error ? err.message : 'network error'}`;
    return { ok: false, issuerReachable: false, ...empty, error };
  }
  if (res.status !== 200) {
    return { ok: false, issuerReachable: true, ...empty, error: `The provider answered HTTP ${res.status} at ${discoveryUrl(trimmed)}.` };
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    return { ok: false, issuerReachable: true, ...empty, error: 'The provider\'s discovery document is not JSON.' };
  }
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const out = {
    issuer: str(doc.issuer),
    authorizationEndpoint: str(doc.authorization_endpoint),
    tokenEndpoint: str(doc.token_endpoint),
    jwksUri: str(doc.jwks_uri),
  };
  if (!out.issuer || !out.authorizationEndpoint || !out.tokenEndpoint || !out.jwksUri) {
    return { ok: false, issuerReachable: true, ...out, error: 'The discovery document lacks issuer, authorization, token or JWKS endpoints.' };
  }
  // oauth2-proxy refuses to start unless the issuer matches exactly. A
  // trailing slash is the usual difference — saving uses the published form.
  if (out.issuer.replace(/\/+$/, '') !== trimmed.replace(/\/+$/, '')) {
    return { ok: false, issuerReachable: true, ...out, error: `The provider publishes its issuer as ${out.issuer}, not ${trimmed}.` };
  }
  return { ok: true, issuerReachable: true, ...out, error: null };
}

/**
 * The issuer as the provider publishes it, when that differs from the input
 * only by a trailing slash; otherwise the input. Never throws.
 */
export async function canonicalIssuer(issuerUrl: string, fetcher: Fetcher = defaultFetcher): Promise<string> {
  try {
    const d = await discoverIssuer(issuerUrl, fetcher);
    if (d.issuer && d.issuer.replace(/\/+$/, '') === issuerUrl.trim().replace(/\/+$/, '')) return d.issuer;
  } catch { /* keep the input */ }
  return issuerUrl.trim();
}

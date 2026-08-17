/**
 * Wildcard hostname semantics — shared by the backend reconcilers and both
 * panels so "is this hostname legal / is it covered by that certificate"
 * has exactly ONE answer in the platform.
 *
 * Two different wildcards are in play and they do NOT have the same rules:
 *
 *   ROUTING wildcard   `*.a.example.test`  — a Traefik rule that matches any
 *                      single label in that position. Arbitrary depth is
 *                      allowed: `*.example.test` and `*.a.example.test` are
 *                      both legal routes on the domain `example.test`.
 *
 *   CERTIFICATE wildcard — an X.509 SAN. Per RFC 6125 a `*.example.test` SAN
 *                      covers exactly ONE label: `www.example.test` yes,
 *                      `a.b.example.test` no, and `example.test` itself no
 *                      (which is why the apex is always issued as a second
 *                      SAN). A wildcard SAN never covers another wildcard.
 *
 * Everything here is pure and side-effect free — no DNS lookups, no k8s.
 */

/** Leading label that marks a wildcard hostname. */
export const WILDCARD_LABEL = '*';

/** Maximum total length of a DNS name (RFC 1035 §2.3.4). */
export const MAX_HOSTNAME_LENGTH = 253;

/** RFC 1123 host label: alphanumeric, inner hyphens, 1–63 chars. */
const LABEL_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Lowercase and strip one trailing dot. DNS providers spell names
 * inconsistently (`example.test.` from PowerDNS, `example.test` elsewhere);
 * every comparison in this module runs on the normalized form.
 */
export function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}

/**
 * True when the hostname is a wildcard pattern (`*.` + at least one label).
 * A bare `*` is not a hostname and returns false.
 */
export function isWildcardHostname(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  return h.startsWith('*.') && h.length > 2;
}

/**
 * The name a wildcard sits under: `*.a.example.test` → `a.example.test`.
 * Returns null for non-wildcard hostnames.
 *
 * Note this is the wildcard's PARENT, which the wildcard itself does not
 * match — `*.example.test` does not match `example.test`.
 */
export function wildcardBase(hostname: string): string | null {
  if (!isWildcardHostname(hostname)) return null;
  return normalizeHostname(hostname).slice(2);
}

/** Number of DNS labels, counting the `*` as one. */
export function labelCount(hostname: string): number {
  const h = normalizeHostname(hostname);
  return h.length === 0 ? 0 : h.split('.').length;
}

/**
 * True when `hostname` is the same name as, or a subdomain of, `parent`.
 * Suffix-safe: `notexample.test` is NOT under `example.test`.
 */
export function isAtOrUnder(hostname: string, parent: string): boolean {
  const h = normalizeHostname(hostname);
  const p = normalizeHostname(parent);
  return h === p || h.endsWith(`.${p}`);
}

/**
 * The record name to use inside `parent`'s zone for this hostname:
 *   ('www.example.test',   'example.test') → 'www'
 *   ('*.a.example.test',   'example.test') → '*.a'
 *   ('example.test',       'example.test') → '@'
 *
 * Slicing by length (rather than `String.replace`) matters: a naive
 * `replace('.example.test', '')` also rewrites the middle of
 * `a.example.test.example.test`.
 */
export function relativeRecordName(hostname: string, parent: string): string {
  const h = normalizeHostname(hostname);
  const p = normalizeHostname(parent);
  if (h === p) return '@';
  if (!h.endsWith(`.${p}`)) return h;
  return h.slice(0, h.length - p.length - 1);
}

export interface HostnameValidationResult {
  readonly ok: boolean;
  /** Normalized hostname — only set when ok. */
  readonly hostname?: string;
  /** Operator-facing reason — only set when !ok. */
  readonly error?: string;
}

/**
 * Validate a hostname that a tenant wants to route, in the context of the
 * domain it must live under.
 *
 * Accepts: the apex itself, any subdomain, and wildcards at any depth whose
 * parent is at or under the domain. Rejects partial-label wildcards
 * (`*x.example.test`), wildcards anywhere but the leading label, and
 * wildcards that reach ABOVE the domain (`*.example.test` on the domain
 * `a.example.test` would ask us to sign names we have no authority over).
 */
export function validateRouteHostname(
  hostname: string,
  domainName: string,
): HostnameValidationResult {
  const h = normalizeHostname(hostname);
  const domain = normalizeHostname(domainName);

  if (h.length === 0) {
    return { ok: false, error: 'Hostname is required' };
  }
  if (h.length > MAX_HOSTNAME_LENGTH) {
    return { ok: false, error: `Hostname exceeds ${MAX_HOSTNAME_LENGTH} characters` };
  }

  const labels = h.split('.');
  if (labels.length < 2) {
    return { ok: false, error: `'${h}' is not a fully qualified hostname` };
  }

  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label === WILDCARD_LABEL) {
      if (i !== 0) {
        return {
          ok: false,
          error: `Wildcards are only allowed as the leftmost label (got '${h}')`,
        };
      }
      continue;
    }
    if (label.includes(WILDCARD_LABEL)) {
      return {
        ok: false,
        error: `'${label}' mixes a wildcard with other characters — use '*' as a whole label (e.g. '*.${domain}')`,
      };
    }
    if (!LABEL_REGEX.test(label)) {
      return { ok: false, error: `'${label}' is not a valid hostname label` };
    }
  }

  // Authority check runs against the wildcard's PARENT so that
  // `*.example.test` is legal on domain `example.test` (parent === domain)
  // but illegal on domain `a.example.test` (parent is above the domain).
  const authorityName = isWildcardHostname(h) ? (wildcardBase(h) as string) : h;
  if (!isAtOrUnder(authorityName, domain)) {
    const suggestion = isWildcardHostname(h) ? `*.${domain}` : `www.${domain}`;
    return {
      ok: false,
      error: `Hostname '${h}' must be '${domain}' or below it (e.g. '${suggestion}')`,
    };
  }

  return { ok: true, hostname: h };
}

/**
 * Does the certificate SAN `san` cover `hostname`?
 *
 * RFC 6125 rules: exact match always; a `*.parent` SAN matches exactly one
 * additional label under `parent`. A wildcard hostname is only ever covered
 * by the identical wildcard SAN — `*.example.test` does not cover
 * `*.a.example.test`, and no SAN wildcard covers a wildcard.
 */
export function sanCoversHostname(san: string, hostname: string): boolean {
  const s = normalizeHostname(san);
  const h = normalizeHostname(hostname);
  if (s === h) return true;
  if (isWildcardHostname(h)) return false; // only an exact SAN covers a wildcard
  if (!isWildcardHostname(s)) return false;

  const base = wildcardBase(s) as string;
  if (!h.endsWith(`.${base}`)) return false;
  const prefix = h.slice(0, h.length - base.length - 1);
  return prefix.length > 0 && !prefix.includes('.');
}

/** True when any SAN in the certificate covers the hostname. */
export function certCoversHostname(
  hostname: string,
  dnsNames: readonly string[],
): boolean {
  return dnsNames.some((san) => sanCoversHostname(san, hostname));
}

/**
 * The SAN list to request for a hostname.
 *
 * A wildcard hostname is issued together with its parent so that
 * `a.example.test` and `x.a.example.test` are both served by one cert —
 * the parent is a name we necessarily control if we can wildcard under it,
 * and it costs nothing in the same ACME order.
 */
export function certDnsNamesForHostname(hostname: string): readonly string[] {
  const h = normalizeHostname(hostname);
  if (!isWildcardHostname(h)) return [h];
  return [h, wildcardBase(h) as string];
}

/**
 * Does a routing wildcard pattern match a concrete hostname?
 * Single label, same as the certificate rule: `*.example.test` matches
 * `www.example.test` but neither `a.b.example.test` nor `example.test`.
 */
export function wildcardMatchesHostname(pattern: string, hostname: string): boolean {
  const p = normalizeHostname(pattern);
  if (!isWildcardHostname(p)) return p === normalizeHostname(hostname);
  return sanCoversHostname(p, hostname);
}

/**
 * Pick the most specific domain that a hostname belongs to.
 *
 * Both `example.test` and `a.example.test` can be registered as separate
 * platform domains; `x.a.example.test` belongs to the LONGER one. Taking
 * the first suffix match instead would attach the route (and its cert) to
 * the wrong zone.
 */
export function longestMatchingDomain<T extends { readonly domainName: string }>(
  hostname: string,
  domains: readonly T[],
): T | null {
  const authorityName = isWildcardHostname(hostname)
    ? (wildcardBase(hostname) as string)
    : normalizeHostname(hostname);

  let best: T | null = null;
  let bestLength = -1;
  for (const domain of domains) {
    const name = normalizeHostname(domain.domainName);
    if (!isAtOrUnder(authorityName, name)) continue;
    if (name.length > bestLength) {
      best = domain;
      bestLength = name.length;
    }
  }
  return best;
}

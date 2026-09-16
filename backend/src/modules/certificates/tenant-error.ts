/**
 * What a tenant is told when their certificate cannot be issued.
 *
 * Production sent this, verbatim, to a customer:
 *
 *   TLS certificate for <host> could not be issued: The certificate request
 *   has failed to complete and will be retried: Failed to wait for order
 *   resource "success-com-na-wildcard-cert-1-1573661536" to become ready
 *
 * That is cert-manager's internal condition text. It names a Kubernetes object
 * the tenant cannot see, in a namespace they do not know exists, and tells
 * them nothing they can act on — while leaking how the platform is built.
 *
 * The raw message is still exactly what the OPERATOR needs, so it is kept for
 * `admin.cert_issuance_failed` and for `ssl_certificates.last_error`. This
 * module is only for the tenant-facing half.
 *
 * Deliberately a translator, not a redactor: stripping the object name from
 * "Failed to wait for order resource …" leaves "Failed to wait for order
 * resource", which is no more actionable. Each pattern maps to the thing the
 * tenant can actually do about it, and anything unrecognised falls back to an
 * honest "we are retrying" rather than passing unknown internals through.
 */

/** Quoted k8s-ish identifiers: `"name-with-dashes-1234567890"`. */
const QUOTED_RESOURCE = /"[a-z0-9][a-z0-9.-]{8,}"/gi;

interface Translation {
  readonly match: RegExp;
  readonly text: string;
}

const TRANSLATIONS: readonly Translation[] = [
  {
    // By far the most common real cause, and the only one the tenant fixes.
    match: /no such host|NXDOMAIN|DNS problem|could not determine the zone|does not resolve/i,
    text: 'The domain\'s DNS is not yet pointing at the platform, so the certificate authority could not verify it.',
  },
  {
    match: /CAA/i,
    text: 'A CAA record on this domain forbids our certificate authority from issuing for it.',
  },
  {
    match: /rate limit|too many certificates|429/i,
    text: 'The certificate authority is temporarily rate-limiting new certificates for this domain.',
  },
  {
    match: /timeout|timed out|deadline exceeded/i,
    text: 'The domain-validation request timed out before it completed.',
  },
  {
    match: /account|registration|unauthorized|403/i,
    text: 'The certificate authority rejected the request for this domain.',
  },
  {
    // `order resource … to become ready` and friends: the request is in
    // flight and nothing is wrong yet from the tenant's side.
    match: /order|challenge|pending|not ready|in progress/i,
    text: 'The certificate request has not completed yet.',
  },
];

const RETRY_NOTE = 'The platform keeps retrying automatically — no action is needed unless this persists.';
const DNS_NOTE = 'Check that the domain\'s DNS records point at the platform.';

/**
 * A tenant-safe explanation, ALWAYS safe to send.
 *
 * Returns a complete sentence (never an empty string) so a template rendering
 * `{{errorMessage}}` cannot produce a dangling "could not be issued: ".
 */
export function tenantSafeCertError(raw: string | null | undefined): string {
  const text = raw?.trim();
  if (!text) {
    return `The certificate could not be issued yet. ${RETRY_NOTE}`;
  }

  for (const t of TRANSLATIONS) {
    if (t.match.test(text)) {
      const note = /no such host|NXDOMAIN|DNS problem|could not determine the zone|does not resolve|CAA/i.test(text)
        ? DNS_NOTE
        : RETRY_NOTE;
      return `${t.text} ${note}`;
    }
  }

  // Unrecognised. Say so honestly rather than forwarding internals: a message
  // nobody has taught this function to translate is, by definition, one we
  // cannot vouch for as tenant-safe.
  return `The certificate could not be issued yet. ${RETRY_NOTE}`;
}

/**
 * Belt and braces for any OTHER path that puts a raw upstream string in front
 * of a tenant: drop quoted object names. Not a substitute for the translator.
 */
export function stripResourceNames(text: string): string {
  return text.replace(QUOTED_RESOURCE, 'the request');
}

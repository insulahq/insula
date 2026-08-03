/**
 * Operator-legible descriptions for outbound `fetch` failures.
 *
 * Node's fetch (undici) collapses EVERY transport-level failure into the
 * single message `fetch failed`. A name that doesn't resolve, a refused
 * connection, a firewall black-hole and an https:// URL pointed at a plain
 * HTTP port are byte-for-byte identical to the caller — the real reason
 * only exists on `err.cause.code`.
 *
 * That is not an academic concern: an operator adding a self-hosted DNS
 * server got `Cannot connect to DNS server: fetch failed` for three
 * different mistakes in a row with no way to tell them apart (2026-08-03).
 * Each of these maps to a completely different fix, so we name the fix.
 *
 * Verified against the live cluster — the three codes below were reproduced
 * from inside the platform-api container:
 *   ENOTFOUND                   http://ns1.mesh.invalid:8081
 *   ERR_SSL_WRONG_VERSION_NUMBER  https:// against a plaintext port
 *   ECONNREFUSED                closed port
 */

/** Node attaches the real failure to `err.cause`; undici nests one more level for TLS. */
function causeCode(err: unknown): string | undefined {
  const cause = (err as { cause?: unknown })?.cause;
  const code = (cause as { code?: unknown })?.code;
  if (typeof code === 'string') return code;
  // TLS errors from the socket layer sometimes sit one level deeper.
  const inner = (cause as { cause?: { code?: unknown } })?.cause?.code;
  return typeof inner === 'string' ? inner : undefined;
}

/** `https://host:8081/api/v1` → `host:8081`, without throwing on a malformed URL. */
function endpointOf(target: string): string {
  try {
    const u = new URL(target);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return target;
  }
}

function schemeOf(target: string): string | undefined {
  try {
    return new URL(target).protocol;
  } catch {
    return undefined;
  }
}

/**
 * Turn a thrown fetch error into a sentence an operator can act on.
 *
 * Returns the ORIGINAL message untouched when it isn't undici's opaque
 * wrapper — an upstream that already said something useful keeps saying it.
 */
export function describeFetchFailure(err: unknown, target: string): string {
  const original = err instanceof Error ? err.message : String(err);
  const where = endpointOf(target);
  const code = causeCode(err);

  // Anything that isn't the opaque wrapper already carries real information.
  if (original !== 'fetch failed' && original !== 'Failed to fetch') return original;

  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `the hostname in ${where} does not resolve from inside the cluster. Pods resolve names through CoreDNS, which does not use the node's /etc/resolv.conf search domains — a mesh- or LAN-only name (for example a .vpn name) needs a CoreDNS forward entry, or use the IP address instead`;
    case 'ECONNREFUSED':
      return `nothing is listening on ${where} (connection refused) — check the port and that the service is bound to an address the cluster can reach, not just 127.0.0.1`;
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
      return `timed out connecting to ${where} — the packets are being dropped rather than refused, which usually means a firewall or a missing route`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `no route from the cluster to ${where} — if this is a mesh address, check the node is still joined to the mesh`;
    case 'ECONNRESET':
      return `${where} reset the connection`;
    case 'EPROTO':
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
    case 'ERR_SSL_PACKET_LENGTH_TOO_LONG':
      return `TLS handshake failed against ${where} — it answered in plain HTTP${
        schemeOf(target) === 'https:' ? ', so use http:// instead of https://' : ''
      }`;
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return `${where} presented a certificate the cluster does not trust (self-signed or an unknown CA)`;
    case 'CERT_HAS_EXPIRED':
      return `the TLS certificate presented by ${where} has expired`;
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `the TLS certificate presented by ${where} is not valid for that hostname`;
    default:
      return code
        ? `could not connect to ${where} (${code})`
        : `could not connect to ${where}`;
  }
}

/**
 * Condense an upstream error body for display.
 *
 * Upstream bodies get spliced into operator-facing messages, and an upstream
 * that is proxied (or blocked by a WAF) answers with a full HTML error page.
 * Pasting that into the panel buries the actual status in markup, so strip
 * tags, collapse whitespace, and cap the length.
 */
export function summarizeUpstreamBody(body: string, maxLength = 200): string {
  const text = body
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

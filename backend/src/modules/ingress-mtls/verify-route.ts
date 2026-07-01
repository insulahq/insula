/**
 * Internal mTLS revocation gate — the ForwardAuth target for mTLS routes.
 *
 * Traefik v3.7 OSS `TLSOption` enforces the CA at the TLS handshake but has no
 * CRL field, so revocation is enforced here: mTLS IngressRoutes carry a
 * `passTLSClientCert` + `forwardAuth` middleware pair (annotation-sync) that
 * forwards the client certificate to this endpoint. We parse its serial and
 * 403 when the cert is revoked; 200 otherwise (ForwardAuth treats 2xx as
 * allow, non-2xx as deny).
 *
 * Registered WITHOUT the `/api/v1` prefix and with no auth hook: it is reached
 * in-cluster via the platform-api Service (the admin panel only proxies
 * `/api/*`, so `/internal/*` is not publicly exposed) and Traefik's
 * forwardAuth cannot carry a bearer token without leaking it into a
 * tenant-namespace Middleware CR. The endpoint reveals nothing sensitive
 * (a boolean revocation verdict) and cannot be used to bypass the CA gate.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { X509Certificate } from 'node:crypto';
import {
  ensureFreshRevocationCache,
  revocationCacheReady,
  isSerialRevoked,
} from './revocation.js';

const CERT_HEADER = 'x-forwarded-tls-client-cert';

const CERT_INFO_HEADER = 'x-forwarded-tls-client-cert-info';

function pemFromBase64Body(decoded: string): string {
  const body = decoded
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/[^A-Za-z0-9+/=]/g, '');
  const lines = body.match(/.{1,64}/g) ?? [body];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/**
 * Recover the client cert serial (lowercase hex) from Traefik's forwarded
 * headers. Traefik's `X-Forwarded-Tls-Client-Cert` PEM escaping has varied by
 * version (`url.QueryEscape` encodes space as `+`, but some paths emit `%20`
 * or raw newlines), so we try several decodings and take the first that parses
 * to an X.509 cert. Falls back to the structured `-Info` header's
 * `SerialNumber="…"` (decimal per Go big.Int.String()) when the PEM won't
 * parse. Returns null when no serial can be recovered.
 */
function serialFromHeaders(certHeader: string, infoHeader: string | undefined): string | null {
  const candidates = [
    certHeader,
    safeDecode(certHeader.replace(/\+/g, '%20')),
    safeDecode(certHeader),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    try {
      return new X509Certificate(pemFromBase64Body(c)).serialNumber.toLowerCase();
    } catch {
      /* try next decoding */
    }
  }
  // Fallback: pull SerialNumber from the -Info header (decimal → hex).
  if (infoHeader) {
    const info = safeDecode(infoHeader.replace(/\+/g, '%20')) ?? infoHeader;
    const m = info.match(/SerialNumber="?([0-9A-Fa-f]+)"?/);
    if (m) {
      const raw = m[1];
      // Heuristic: all-digits and long → decimal; else already hex.
      if (/^[0-9]+$/.test(raw) && raw.length > 12) {
        try { return BigInt(raw).toString(16); } catch { /* fall through */ }
      }
      return raw.toLowerCase();
    }
  }
  return null;
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

export async function mtlsVerifyRoutes(app: FastifyInstance): Promise<void> {
  const DEBUG = process.env.MTLS_VERIFY_DEBUG === '1';
  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const hdr = request.headers[CERT_HEADER];
    const certHeader = Array.isArray(hdr) ? hdr[0] : hdr;
    if (DEBUG) {
      request.log.warn({
        headerKeys: Object.keys(request.headers).filter((k) => k.startsWith('x-forwarded-tls')),
        certLen: certHeader?.length ?? 0,
        certHead: certHeader?.slice(0, 70) ?? null,
      }, 'mtls-verify: incoming');
    }

    // No client cert presented. The TLSOption already governed admission at
    // the handshake (RequireAndVerify would have rejected; optional modes
    // allow no cert). There is nothing to revoke → allow.
    if (!certHeader) {
      reply.code(200).send('ok');
      return;
    }

    const infoHdr = request.headers[CERT_INFO_HEADER];
    const infoHeader = Array.isArray(infoHdr) ? infoHdr[0] : infoHdr;
    const serial = serialFromHeaders(certHeader, infoHeader);
    if (!serial) {
      // A cert we cannot parse must fail closed — never treat a malformed or
      // forged header as a valid, unrevoked certificate. Always log (rare,
      // and signals a misconfigured mTLS route); the sample is truncated.
      request.log.warn({
        rawLen: certHeader.length,
        rawHead: certHeader.slice(0, 90),
        hasInfo: Boolean(infoHeader),
      }, 'mtls-verify: unparseable client certificate');
      reply.code(403).send('mtls: unparseable client certificate');
      return;
    }

    try {
      await ensureFreshRevocationCache(app.db);
    } catch {
      /* ensureFresh swallows its own errors; guard defensively anyway. */
    }
    if (!revocationCacheReady()) {
      // Never loaded (DB unreachable at first use) → fail closed.
      if (DEBUG) request.log.warn({ serial }, 'mtls-verify: cache not ready → deny');
      reply.code(403).send('mtls: revocation cache unavailable');
      return;
    }
    const revoked = isSerialRevoked(serial);
    if (DEBUG) request.log.warn({ serial, revoked }, 'mtls-verify: verdict');
    if (revoked) {
      reply.code(403).send('mtls: certificate revoked');
      return;
    }
    reply.code(200).send('ok');
  };

  // forwardAuth issues a GET by default; accept POST too for robustness.
  app.route({ method: ['GET', 'POST'], url: '/internal/mtls/verify', handler });
}

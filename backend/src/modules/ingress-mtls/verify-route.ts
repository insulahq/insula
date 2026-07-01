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

/**
 * Rebuild a parseable PEM from Traefik's `X-Forwarded-Tls-Client-Cert` value,
 * which is the certificate URL-encoded and may arrive with or without the PEM
 * armor and newlines. We strip everything down to the base64 body and re-wrap.
 */
function reconstructPem(raw: string): string {
  const body = raw
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [body];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

export async function mtlsVerifyRoutes(app: FastifyInstance): Promise<void> {
  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const hdr = request.headers[CERT_HEADER];
    const certHeader = Array.isArray(hdr) ? hdr[0] : hdr;

    // No client cert presented. The TLSOption already governed admission at
    // the handshake (RequireAndVerify would have rejected; optional modes
    // allow no cert). There is nothing to revoke → allow.
    if (!certHeader) {
      reply.code(200).send('ok');
      return;
    }

    let serial: string;
    try {
      const pem = reconstructPem(decodeURIComponent(certHeader));
      serial = new X509Certificate(pem).serialNumber;
    } catch {
      // A cert we cannot parse must fail closed — never treat a malformed or
      // forged header as a valid, unrevoked certificate.
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
      reply.code(403).send('mtls: revocation cache unavailable');
      return;
    }
    if (isSerialRevoked(serial)) {
      reply.code(403).send('mtls: certificate revoked');
      return;
    }
    reply.code(200).send('ok');
  };

  // forwardAuth issues a GET by default; accept POST too for robustness.
  app.route({ method: ['GET', 'POST'], url: '/internal/mtls/verify', handler });
}

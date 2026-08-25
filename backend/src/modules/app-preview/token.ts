/**
 * HMAC-signed, stateless preview tokens.
 *
 * A token authorizes the proxy to reach EXACTLY ONE (namespace, service,
 * port) tuple until `exp`. Stateless by design: HA-safe with any number
 * of platform-api replicas (no session table), and the blast radius of a
 * leaked token is one in-cluster Service for a few minutes. Signed with
 * PLATFORM_INTERNAL_SECRET — the same secret that already gates the
 * /internal/* surface, so no new key material to provision.
 *
 * Shape: base64url(JSON payload) + '.' + base64url(HMAC-SHA256(payloadB64)).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const PREVIEW_TOKEN_TTL_MS = 15 * 60 * 1000;

export interface PreviewTokenPayload {
  readonly v: 1;
  readonly ns: string;
  readonly svc: string;
  readonly port: number;
  /** Unix ms expiry. */
  readonly exp: number;
}

function signingSecret(): string {
  const s = process.env.PLATFORM_INTERNAL_SECRET?.trim();
  if (!s) throw new Error('PLATFORM_INTERNAL_SECRET is not set — preview tokens unavailable');
  return s;
}

function hmac(payloadB64: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payloadB64).digest();
}

export function mintPreviewToken(
  target: { ns: string; svc: string; port: number },
  nowMs: number,
): { token: string; expiresAt: string } {
  const payload: PreviewTokenPayload = {
    v: 1,
    ns: target.ns,
    svc: target.svc,
    port: target.port,
    exp: nowMs + PREVIEW_TOKEN_TTL_MS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = hmac(payloadB64, signingSecret()).toString('base64url');
  return { token: `${payloadB64}.${sig}`, expiresAt: new Date(payload.exp).toISOString() };
}

/** Returns the payload for a valid, unexpired token; null otherwise. */
export function verifyPreviewToken(token: string, nowMs: number): PreviewTokenPayload | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  let expected: Buffer;
  try {
    expected = hmac(payloadB64, signingSecret());
  } catch {
    return null;
  }
  let got: Buffer;
  try {
    got = Buffer.from(sigB64, 'base64url');
  } catch {
    return null;
  }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;

  let payload: PreviewTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as PreviewTokenPayload;
  } catch {
    return null;
  }
  if (payload.v !== 1) return null;
  if (typeof payload.ns !== 'string' || typeof payload.svc !== 'string') return null;
  if (typeof payload.port !== 'number' || typeof payload.exp !== 'number') return null;
  if (payload.exp <= nowMs) return null;
  // Defense-in-depth: the payload feeds a URL/DNS name — reject anything
  // that is not a plain lowercase RFC-1123 label chain even though only
  // our own mint path can produce a valid signature.
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(payload.ns)) return null;
  if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(payload.svc)) return null;
  if (payload.port < 1 || payload.port > 65535) return null;
  return payload;
}

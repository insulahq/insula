/**
 * TOTP (RFC 6238) and base32 (RFC 4648) — the pure, I/O-free half of the
 * authenticator-app second factor. totp-service.ts owns storage, replay and
 * lockout; this file only answers "what is the code at time t" and "which
 * step, if any, does this code belong to".
 *
 * Parameters are the ones every authenticator app defaults to: HMAC-SHA1,
 * 6 digits, 30-second steps. They are not configurable on purpose — a
 * non-default value is silently ignored by several popular apps, which then
 * show codes that never match.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps accepted either side of "now" — absorbs a phone clock off by up to 30 s. */
export const TOTP_WINDOW_STEPS = 1;
/** 160-bit secret, the RFC 4226 recommendation and what apps expect. */
export const TOTP_SECRET_BYTES = 20;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  // Counters exceed 2^32 only after year 2106 at 30 s steps, but write both
  // halves anyway so the RFC's t=20000000000 vector holds.
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24)
    | (mac[offset + 1] << 16)
    | (mac[offset + 2] << 8)
    | mac[offset + 3];
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export function stepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code an authenticator shows at `nowMs`. */
export function totpAt(secret: Buffer, nowMs: number): string {
  return hotp(secret, stepAt(nowMs));
}

/**
 * The time step `code` belongs to, within ±TOTP_WINDOW_STEPS of `nowMs`, or
 * null. Returning the step (not a boolean) lets the caller refuse a code
 * whose step was already used — the replay barrier lives in the service.
 * Every candidate is compared in constant time.
 */
export function matchTotp(secret: Buffer, code: string, nowMs: number): number | null {
  const candidate = code.replace(/\s/g, '');
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(candidate)) return null;
  const given = Buffer.from(candidate);
  const current = stepAt(nowMs);
  let matched: number | null = null;
  for (let step = current - TOTP_WINDOW_STEPS; step <= current + TOTP_WINDOW_STEPS; step += 1) {
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), given) && matched === null) matched = step;
  }
  return matched;
}

/** The `otpauth://` URI an authenticator app imports (usually from a QR code). */
export function otpauthUri(input: { issuer: string; account: string; secret: Buffer }): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  // Percent-encoding throughout, not URLSearchParams: that writes a space as
  // `+`, which several authenticator apps then show literally in the issuer.
  const query = [
    ['secret', base32Encode(input.secret)],
    ['issuer', input.issuer],
    ['algorithm', 'SHA1'],
    ['digits', String(TOTP_DIGITS)],
    ['period', String(TOTP_PERIOD_SECONDS)],
  ].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `otpauth://totp/${label}?${query}`;
}

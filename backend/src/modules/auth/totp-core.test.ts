import { describe, expect, it } from 'vitest';
import {
  TOTP_PERIOD_SECONDS,
  base32Decode,
  base32Encode,
  matchTotp,
  totpAt,
  otpauthUri,
} from './totp-core.js';

// RFC 6238 Appendix B — SHA-1 seed "12345678901234567890" (ASCII). The RFC
// prints 8-digit values; a 6-digit code is the same truncation mod 10^6.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: Array<[number, string]> = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

describe('TOTP (RFC 6238)', () => {
  it.each(RFC_VECTORS)('at t=%i the code is %s', (t, code) => {
    expect(totpAt(RFC_SECRET, t * 1000)).toBe(code);
  });

  it('accepts the current step and one step either side, and says which', () => {
    const now = 1111111111 * 1000;
    const step = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, now), now)).toBe(step);
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, now - 30_000), now)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, now + 30_000), now)).toBe(step + 1);
  });

  it('refuses codes outside the window, malformed input, and wrong codes', () => {
    const now = 1111111111 * 1000;
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, now - 60_000), now)).toBeNull();
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, now + 60_000), now)).toBeNull();
    expect(matchTotp(RFC_SECRET, '12345', now)).toBeNull();
    expect(matchTotp(RFC_SECRET, '1234567', now)).toBeNull();
    expect(matchTotp(RFC_SECRET, 'abcdef', now)).toBeNull();
    const right = totpAt(RFC_SECRET, now);
    const wrong = String((Number(right) + 1) % 1_000_000).padStart(6, '0');
    expect(matchTotp(RFC_SECRET, wrong, now)).toBeNull();
  });

  it('tolerates the spaces an authenticator app shows inside a code', () => {
    const now = 59 * 1000;
    expect(matchTotp(RFC_SECRET, '287 082', now)).not.toBeNull();
  });
});

describe('base32 (RFC 4648)', () => {
  const vectors: Array<[string, string]> = [
    ['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI'],
  ];
  it.each(vectors)('%j encodes to %s (no padding — what authenticator apps expect)', (plain, enc) => {
    expect(base32Encode(Buffer.from(plain, 'ascii'))).toBe(enc);
  });

  it.each(vectors)('%j decodes back, with or without padding, in any case', (plain, enc) => {
    expect(base32Decode(enc).toString('ascii')).toBe(plain);
    expect(base32Decode(enc.toLowerCase()).toString('ascii')).toBe(plain);
    const padded = enc + '='.repeat((8 - (enc.length % 8)) % 8);
    expect(base32Decode(padded).toString('ascii')).toBe(plain);
  });

  it('round-trips a 20-byte secret', () => {
    const secret = Buffer.from('3132333435363738393031323334353637383930', 'hex');
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
  });

  it('refuses characters outside the alphabet', () => {
    expect(() => base32Decode('MZXW1')).toThrow();
  });
});

describe('otpauth URI', () => {
  it('names the issuer and account, and carries the secret and parameters', () => {
    const uri = otpauthUri({ issuer: 'Insula (admin)', account: 'ada@example.test', secret: RFC_SECRET });
    const url = new URL(uri);
    expect(url.protocol).toBe('otpauth:');
    expect(url.host).toBe('totp');
    expect(decodeURIComponent(url.pathname)).toBe('/Insula (admin):ada@example.test');
    expect(url.searchParams.get('secret')).toBe(base32Encode(RFC_SECRET));
    expect(url.searchParams.get('issuer')).toBe('Insula (admin)');
    expect(url.searchParams.get('algorithm')).toBe('SHA1');
    expect(url.searchParams.get('digits')).toBe('6');
    expect(url.searchParams.get('period')).toBe('30');
    // A `+` for a space would show up literally in some authenticator apps.
    expect(uri).not.toContain('+');
    expect(uri).toContain('issuer=Insula%20(admin)');
  });
});

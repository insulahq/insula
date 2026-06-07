/**
 * Unit tests for the DKIM-rotation pure helpers.
 *
 * Full E2E coverage (Stalwart API call + DNS provider push) lives
 * in the integration harness — the helpers here are the parts that
 * matter for correctness in isolation: selector format, RSA
 * key shape.
 */

import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  newDkimSelector,
} from './rotate.js';

import { generateDkimKeyPair } from '../email-domains/dkim.js';

describe('email-dkim/rotate: key generation (shared RSA generator)', () => {
  it('returns PEM-encoded RSA key pair', () => {
    const { privateKey, publicKey } = generateDkimKeyPair();
    expect(privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(privateKey).toMatch(/-----END PRIVATE KEY-----\s*$/);
    expect(publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(publicKey).toMatch(/-----END PUBLIC KEY-----\s*$/);
  });

  it('two consecutive calls produce different keys', () => {
    const a = generateDkimKeyPair();
    const b = generateDkimKeyPair();
    expect(a.privateKey).not.toEqual(b.privateKey);
    expect(a.publicKey).not.toEqual(b.publicKey);
  });

  it('generates an RSA-2048 key (matches the k=rsa DNS tag + Dkim1RsaSha256 type)', () => {
    const { publicKey } = generateDkimKeyPair();

    const key = crypto.createPublicKey(publicKey);
    expect(key.asymmetricKeyType).toBe('rsa');
    expect(key.asymmetricKeyDetails?.modulusLength).toBe(2048);
  });
});

describe('email-dkim/rotate: newDkimSelector', () => {
  it('returns a YYYYMMDDhhmmss-format selector with dkim- prefix', () => {
    const sel = newDkimSelector(new Date('2026-05-06T19:42:33Z').getTime());
    expect(sel).toBe('dkim-20260506194233');
  });

  it('zero-pads single-digit components', () => {
    const sel = newDkimSelector(new Date('2026-01-02T03:04:05Z').getTime());
    expect(sel).toBe('dkim-20260102030405');
  });

  it('second-precision avoids minute-boundary collisions', () => {
    const t = new Date('2026-05-06T19:42:00Z').getTime();
    const a = newDkimSelector(t);
    const b = newDkimSelector(t + 1_000); // 1s later, same minute — DIFFERENT
    const c = newDkimSelector(t + 60_000); // 1min later — DIFFERENT
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it('selector contains only DNS-safe characters', () => {
    const sel = newDkimSelector();
    // RFC 5321: A-Z, a-z, 0-9, hyphen
    expect(sel).toMatch(/^[a-z0-9-]+$/);
  });
});

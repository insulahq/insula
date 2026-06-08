import { describe, expect, it } from 'vitest';

import {
  updatePlatformUrlsSchema,
  updateWebmailSettingsSchema,
} from '@insula/api-contracts';

/**
 * H1 (write boundary): the `mailServerHostname` field is interpolated
 * into a Traefik match rule `Host(`<host>`) && …` by the
 * mail-acme-override-route reconciler. It MUST be constrained to a
 * valid RFC-1123 DNS hostname at the API write boundary so a crafted
 * value with backticks/parentheses can never reach the reconciler.
 */
describe('mailServerHostname DNS-hostname validation (api-contracts)', () => {
  const validHost = 'mx.override.example.org';
  const injection = 'x`)||Host(`evil.com';

  describe('updateWebmailSettingsSchema', () => {
    it('accepts a valid DNS hostname', () => {
      const r = updateWebmailSettingsSchema.safeParse({ mailServerHostname: validHost });
      expect(r.success).toBe(true);
    });

    it('rejects a Traefik match-injection payload', () => {
      const r = updateWebmailSettingsSchema.safeParse({ mailServerHostname: injection });
      expect(r.success).toBe(false);
    });

    it('still allows the field to be omitted', () => {
      const r = updateWebmailSettingsSchema.safeParse({});
      expect(r.success).toBe(true);
    });
  });

  describe('updatePlatformUrlsSchema', () => {
    it('accepts a valid DNS hostname', () => {
      const r = updatePlatformUrlsSchema.safeParse({ mailServerHostname: validHost });
      expect(r.success).toBe(true);
    });

    it('rejects a Traefik match-injection payload', () => {
      const r = updatePlatformUrlsSchema.safeParse({ mailServerHostname: injection });
      expect(r.success).toBe(false);
    });

    it('still allows null (reset-to-default sentinel)', () => {
      const r = updatePlatformUrlsSchema.safeParse({ mailServerHostname: null });
      expect(r.success).toBe(true);
    });
  });
});

/**
 * default_webmail_url's hostname is interpolated into a Traefik
 * `Host(`<host>`)` match rule AND the stalwart-jmap-cors ACAO by the
 * webmail-router reconciler, so the write boundary must reject anything
 * that isn't an http(s) URL with a clean RFC-1123 hostname.
 */
describe('defaultWebmailUrl URL+hostname validation (api-contracts)', () => {
  it('accepts a normal https webmail URL', () => {
    const r = updateWebmailSettingsSchema.safeParse({ defaultWebmailUrl: 'https://webmail.example.com/' });
    expect(r.success).toBe(true);
  });
  it('accepts http + internal FQDN (no TLD restriction)', () => {
    const r = updateWebmailSettingsSchema.safeParse({ defaultWebmailUrl: 'http://webmail.corp.internal/' });
    expect(r.success).toBe(true);
  });
  it('rejects a Traefik match-injection payload in the host', () => {
    const r = updateWebmailSettingsSchema.safeParse({ defaultWebmailUrl: 'https://x`)||Host(`evil.com/' });
    expect(r.success).toBe(false);
  });
  it('rejects a non-http(s) scheme', () => {
    const r = updateWebmailSettingsSchema.safeParse({ defaultWebmailUrl: 'ftp://webmail.example.com/' });
    expect(r.success).toBe(false);
  });
  it('rejects a single-label host', () => {
    const r = updateWebmailSettingsSchema.safeParse({ defaultWebmailUrl: 'https://localhost/' });
    expect(r.success).toBe(false);
  });
  it('still allows the field to be omitted', () => {
    const r = updateWebmailSettingsSchema.safeParse({});
    expect(r.success).toBe(true);
  });
});

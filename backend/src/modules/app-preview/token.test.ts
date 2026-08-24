import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintPreviewToken, verifyPreviewToken, PREVIEW_TOKEN_TTL_MS } from './token.js';

const T0 = 1_787_600_000_000;

describe('preview tokens', () => {
  beforeEach(() => vi.stubEnv('PLATFORM_INTERNAL_SECRET', 'unit-test-secret-0001'));
  afterEach(() => vi.unstubAllEnvs());

  const target = { ns: 'tenant-abc123', svc: 'web-http', port: 8080 };

  it('roundtrips a minted token', () => {
    const { token, expiresAt } = mintPreviewToken(target, T0);
    const p = verifyPreviewToken(token, T0 + 1000);
    expect(p).not.toBeNull();
    expect(p!.ns).toBe(target.ns);
    expect(p!.svc).toBe(target.svc);
    expect(p!.port).toBe(target.port);
    expect(new Date(expiresAt).getTime()).toBe(T0 + PREVIEW_TOKEN_TTL_MS);
  });

  it('rejects an expired token', () => {
    const { token } = mintPreviewToken(target, T0);
    expect(verifyPreviewToken(token, T0 + PREVIEW_TOKEN_TTL_MS + 1)).toBeNull();
  });

  it('rejects a tampered payload (signature mismatch)', () => {
    const { token } = mintPreviewToken(target, T0);
    const [payload, sig] = token.split('.');
    const evil = JSON.parse(Buffer.from(payload, 'base64url').toString());
    evil.svc = 'platform-api';
    evil.ns = 'platform';
    const tampered = `${Buffer.from(JSON.stringify(evil)).toString('base64url')}.${sig}`;
    expect(verifyPreviewToken(tampered, T0)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const { token } = mintPreviewToken(target, T0);
    vi.stubEnv('PLATFORM_INTERNAL_SECRET', 'a-rotated-secret-000002');
    expect(verifyPreviewToken(token, T0)).toBeNull();
  });

  it('rejects malformed inputs', () => {
    expect(verifyPreviewToken('', T0)).toBeNull();
    expect(verifyPreviewToken('no-dot', T0)).toBeNull();
    expect(verifyPreviewToken('a.', T0)).toBeNull();
    expect(verifyPreviewToken('.b', T0)).toBeNull();
    expect(verifyPreviewToken('%%%.%%%', T0)).toBeNull();
  });

  it('rejects payloads with non-DNS names even if correctly signed', () => {
    // Mint with hostile values through the mint path itself — verify must
    // refuse them (defense-in-depth against a future mint-path bug).
    const { token } = mintPreviewToken({ ns: 'Tenant_UPPER', svc: 'ok', port: 80 }, T0);
    expect(verifyPreviewToken(token, T0)).toBeNull();
  });
});

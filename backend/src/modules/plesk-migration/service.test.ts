import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encrypt } from '../oidc/crypto.js';
import { toSourceResponse, decryptSourceKey, normalizePrivateKey } from './service.js';

const KEY = 'a'.repeat(64);
beforeEach(() => { process.env.PLATFORM_ENCRYPTION_KEY = KEY; });

function row(extra: Record<string, unknown> = {}) {
  return {
    id: 's1', name: 'box', hostname: 'plesk.example.com', sshPort: 22, sshUser: 'root',
    sshKeyEncrypted: encrypt('PRIVATE-KEY-MATERIAL', KEY),
    pleskVersion: 'Plesk Obsidian 18', passwordStorage: 'sym',
    lastDiscoveredAt: null, status: 'discovered', createdBy: 'u1', createdAt: new Date(),
    ...extra,
  } as Parameters<typeof toSourceResponse>[0];
}

describe('toSourceResponse', () => {
  it('NEVER exposes the encrypted key or createdBy in the response', () => {
    const resp = toSourceResponse(row());
    expect(JSON.stringify(resp)).not.toContain('sshKeyEncrypted');
    expect(JSON.stringify(resp)).not.toContain('PRIVATE-KEY');
    expect('sshKeyEncrypted' in resp).toBe(false);
  });

  it('returns the operator-facing fields', () => {
    const resp = toSourceResponse(row());
    expect(resp).toMatchObject({
      id: 's1', hostname: 'plesk.example.com', sshUser: 'root',
      pleskVersion: 'Plesk Obsidian 18', passwordStorage: 'sym', status: 'discovered',
    });
  });
});

describe('decryptSourceKey', () => {
  it('round-trips the key for in-process use only', () => {
    expect(decryptSourceKey(row())).toBe('PRIVATE-KEY-MATERIAL');
  });
});

describe('normalizePrivateKey', () => {
  const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNz\n-----END OPENSSH PRIVATE KEY-----';

  it('appends the trailing newline OpenSSH requires (the discovery-killer)', () => {
    // A key pasted/captured without a trailing newline → libcrypto parse
    // error → Permission denied. Normalization fixes it.
    expect(normalizePrivateKey(PEM)).toBe(`${PEM}\n`);
  });

  it('leaves a correctly-terminated key with exactly one trailing newline', () => {
    expect(normalizePrivateKey(`${PEM}\n`)).toBe(`${PEM}\n`);
  });

  it('collapses multiple trailing newlines to one', () => {
    expect(normalizePrivateKey(`${PEM}\n\n\n`)).toBe(`${PEM}\n`);
  });

  it('converts CRLF paste to LF so the PEM is not corrupted', () => {
    expect(normalizePrivateKey('-----BEGIN-----\r\nAAAA\r\n-----END-----\r\n'))
      .toBe('-----BEGIN-----\nAAAA\n-----END-----\n');
  });

  it('leaves an empty string empty (no stray newline)', () => {
    expect(normalizePrivateKey('')).toBe('');
  });
});

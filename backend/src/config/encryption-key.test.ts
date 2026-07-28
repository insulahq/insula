import { describe, it, expect, vi, afterEach } from 'vitest';
import { assertEncryptionKeyUsable } from './index.js';
import type { Config } from './index.js';

const base = (over: Partial<Config>): Config => ({
  NODE_ENV: 'production',
  PORT: 3000,
  DATABASE_URL: 'postgresql://u:p@h/db',
  JWT_SECRET: 'x'.repeat(32),
  LOG_LEVEL: 'info',
  REDIS_URL: 'redis://localhost:6379',
  PLATFORM_ENV: 'production',
  PLATFORM_VERSION: '0.0.0',
  DEFAULT_STORAGE_CLASS: 'local-path',
  FILE_MANAGER_IMAGE: 'img',
  TUNNEL_BASE_URL: 'wss://example.test',
  PRIVATE_WORKER_FRPS_IMAGE: 'img',
  PRIVATE_WORKER_AGENT_IMAGE: 'img',
  STORAGE_SNAPSHOT_BACKEND: 'hostpath',
  STORAGE_SNAPSHOT_HOST_ROOT: '/var/lib/platform/snapshots',
  STORAGE_SNAPSHOT_LOCAL_ROOT: '/snapshots',
  PLATFORM_NAMESPACE: 'platform',
  ...over,
} as Config);

const GOOD_KEY = 'a'.repeat(64);

afterEach(() => { vi.restoreAllMocks(); });

describe('assertEncryptionKeyUsable', () => {
  for (const env of ['production', 'staging'] as const) {
    it(`THROWS when the key is missing and PLATFORM_ENV=${env}`, () => {
      expect(() => assertEncryptionKeyUsable(
        base({ PLATFORM_ENV: env, PLATFORM_ENCRYPTION_KEY: undefined }),
      )).toThrow(/PLATFORM_ENCRYPTION_KEY is required/);
    });

    it(`accepts a well-formed key when PLATFORM_ENV=${env}`, () => {
      expect(() => assertEncryptionKeyUsable(
        base({ PLATFORM_ENV: env, PLATFORM_ENCRYPTION_KEY: GOOD_KEY }),
      )).not.toThrow();
    });
  }

  for (const env of ['development', 'dev'] as const) {
    it(`only WARNS when the key is missing and PLATFORM_ENV=${env}`, () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => assertEncryptionKeyUsable(
        base({ PLATFORM_ENV: env, PLATFORM_ENCRYPTION_KEY: undefined }),
      )).not.toThrow();
      expect(warn).toHaveBeenCalledOnce();
    });
  }

  it('THROWS on a malformed key even in development (fails at boot, not mid-request)', () => {
    // Buffer.from(key,'hex') parses only up to the first non-hex char, so a
    // passphrase becomes a short key and createCipheriv throws per-request.
    expect(() => assertEncryptionKeyUsable(
      base({ PLATFORM_ENV: 'development', PLATFORM_ENCRYPTION_KEY: 'not-a-hex-key-but-32-chars-long!' }),
    )).toThrow(/must be 64 hex characters/);
  });

  it('THROWS on a hex key of the wrong length', () => {
    for (const key of ['a'.repeat(32), 'a'.repeat(63), 'a'.repeat(128)]) {
      expect(() => assertEncryptionKeyUsable(
        base({ PLATFORM_ENCRYPTION_KEY: key }),
      )).toThrow(/must be 64 hex characters/);
    }
  });

  it('accepts uppercase hex', () => {
    expect(() => assertEncryptionKeyUsable(
      base({ PLATFORM_ENCRYPTION_KEY: 'ABCDEF0123456789'.repeat(4) }),
    )).not.toThrow();
  });

  it('accepts what `openssl rand -hex 32` actually produces', async () => {
    const { randomBytes } = await import('node:crypto');
    const key = randomBytes(32).toString('hex');
    expect(key).toHaveLength(64);
    expect(() => assertEncryptionKeyUsable(base({ PLATFORM_ENCRYPTION_KEY: key }))).not.toThrow();
  });
});

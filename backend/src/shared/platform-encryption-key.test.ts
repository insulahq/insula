import { describe, it, expect } from 'vitest';
import { platformEncryptionKey, MissingEncryptionKeyError } from './platform-encryption-key.js';

describe('platformEncryptionKey', () => {
  it('returns the configured key', () => {
    expect(platformEncryptionKey({ PLATFORM_ENCRYPTION_KEY: 'ab'.repeat(32), PLATFORM_ENV: 'production' })).toBe('ab'.repeat(32));
  });

  // Never the all-zero key anyone reading the repo knows, where real secrets live.
  it('throws instead of falling back to the zero key in production and staging', () => {
    expect(() => platformEncryptionKey({ PLATFORM_ENV: 'production' })).toThrow(MissingEncryptionKeyError);
    expect(() => platformEncryptionKey({ PLATFORM_ENV: 'staging' })).toThrow(/PLATFORM_ENCRYPTION_KEY is required/);
  });

  it('keeps the zero-key fallback for development and tests', () => {
    expect(platformEncryptionKey({ PLATFORM_ENV: 'development' })).toBe('0'.repeat(64));
    expect(platformEncryptionKey({})).toBe('0'.repeat(64));
  });
});

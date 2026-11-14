/**
 * PLATFORM_ENCRYPTION_KEY for a call site that encrypts or decrypts stored
 * secrets — one place instead of `process.env.PLATFORM_ENCRYPTION_KEY ??
 * '0'.repeat(64)` copied into every module.
 *
 * Where the key is required (production, staging — the same rule as
 * config/index.ts assertEncryptionKeyUsable, which refuses to boot without it)
 * a missing key THROWS here rather than quietly encrypting under the all-zero
 * key anyone reading this repo knows. Development and tests keep the zero-key
 * fallback.
 */

const KEY_REQUIRED_ENVS: ReadonlySet<string> = new Set(['production', 'staging']);

export class MissingEncryptionKeyError extends Error {
  constructor(where: string) {
    super(`PLATFORM_ENCRYPTION_KEY is required when ${where}; refusing to use the zero key`);
    this.name = 'MissingEncryptionKeyError';
  }
}

export function platformEncryptionKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.PLATFORM_ENCRYPTION_KEY;
  if (key) return key;
  const platformEnv = env.PLATFORM_ENV ?? 'development';
  if (KEY_REQUIRED_ENVS.has(platformEnv)) throw new MissingEncryptionKeyError(`PLATFORM_ENV=${platformEnv}`);
  // A production build with PLATFORM_ENV left at its development default is
  // still production: never the zero key there either.
  if (env.NODE_ENV === 'production') throw new MissingEncryptionKeyError('NODE_ENV=production');
  return '0'.repeat(64);
}

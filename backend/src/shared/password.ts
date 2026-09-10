/**
 * Cryptographically secure password generator, shared by every path
 * that mints a login credential on a user's behalf:
 *   - tenant creation (the auto-provisioned `tenant_admin` login)
 *   - sub-user creation
 *   - sub-user password reset
 *
 * Those paths deliberately do NOT accept an operator-supplied
 * password. Manual entry produced weak and reused credentials, and
 * left no way to tell whether a password had ever been rotated. The
 * generated value is returned to the caller exactly once, at the
 * moment it is set, and only the bcrypt hash is persisted.
 */

/**
 * 68 characters: mixed-case alpha, digits, and a punctuation set that
 * survives copy/paste and shell quoting. Kept identical to the
 * alphabet the tenant-create path has always used so generated
 * credentials stay visually consistent across the product.
 */
const PASSWORD_ALPHABET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*';

/** ~122 bits of entropy over the 68-character alphabet. */
export const GENERATED_PASSWORD_LENGTH = 20;

/**
 * Draw `length` characters uniformly from `PASSWORD_ALPHABET` using
 * the platform CSPRNG.
 *
 * Bytes landing in the final, partial cycle of the alphabet are
 * rejected rather than folded with `%`: 256 is not a multiple of 68,
 * so a bare `byte % 68` would pick the first 52 characters ~1.3× as
 * often as the last 16.
 */
export function generateStrongPassword(length: number = GENERATED_PASSWORD_LENGTH): string {
  const alphabetSize = PASSWORD_ALPHABET.length;
  const limit = Math.floor(256 / alphabetSize) * alphabetSize;

  const chars: string[] = [];
  while (chars.length < length) {
    // Over-draw so the common case needs a single getRandomValues call
    // even after a few rejections.
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      chars.push(PASSWORD_ALPHABET[byte % alphabetSize]!);
      if (chars.length === length) break;
    }
  }
  return chars.join('');
}

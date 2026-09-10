import { describe, it, expect } from 'vitest';
import { generateStrongPassword, GENERATED_PASSWORD_LENGTH } from './password.js';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*';

describe('generateStrongPassword', () => {
  it('returns the default length', () => {
    expect(generateStrongPassword()).toHaveLength(GENERATED_PASSWORD_LENGTH);
  });

  it('honours an explicit length', () => {
    expect(generateStrongPassword(32)).toHaveLength(32);
    expect(generateStrongPassword(1)).toHaveLength(1);
  });

  it('emits only alphabet characters', () => {
    // A rejection-sampling bug that lets an out-of-range byte through
    // would surface as `undefined` concatenated into the string.
    for (let i = 0; i < 50; i++) {
      for (const ch of generateStrongPassword()) {
        expect(ALPHABET).toContain(ch);
      }
    }
  });

  it('can still produce every character in the alphabet', () => {
    // Rejection sampling drops bytes above the last whole cycle. Get
    // the boundary wrong and the tail of the alphabet becomes
    // unreachable — the password stays well-formed and the length is
    // right, so nothing else here would notice.
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      for (const ch of generateStrongPassword()) seen.add(ch);
    }
    expect(seen.size).toBe(ALPHABET.length);
  });

  it('does not repeat itself', () => {
    const values = new Set(Array.from({ length: 200 }, () => generateStrongPassword()));
    expect(values.size).toBe(200);
  });
});

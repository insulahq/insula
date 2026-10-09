import { describe, it, expect } from 'vitest';
import { plainText } from './plain-text.js';

describe('plainText', () => {
  it('strips terminal escape sequences and control characters, keeps the words', () => {
    expect(plainText('\x1b[2J\x1b[Hexit 3: \x1b]0;pwned\x07disk full\x1b[0m')).toBe('exit 3: disk full');
    expect(plainText('a\x00b\x07c\x9bd')).toBe('abcd');
  });
  it('folds line breaks into one line and caps the length', () => {
    expect(plainText('line one\r\nline two\tend')).toBe('line one line two end');
    expect(plainText('x'.repeat(900)).length).toBe(500);
    expect(plainText('x'.repeat(900), 20).length).toBe(20);
  });
  it('leaves ordinary text (and non-ASCII) alone', () => {
    expect(plainText('apt-get: Fehler — Paket nicht gefunden')).toBe('apt-get: Fehler — Paket nicht gefunden');
  });
});

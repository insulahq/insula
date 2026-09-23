import { describe, it, expect } from 'vitest';
import { formatVersion } from './format-version';

describe('formatVersion', () => {
  it('adds the leading v', () => {
    expect(formatVersion('2026.9.31')).toBe('v2026.9.31');
  });

  it('does not double-prefix a version that already has one', () => {
    // Git tags arrive already prefixed; `vv2026.9.31` is worse than either.
    expect(formatVersion('v2026.9.31')).toBe('v2026.9.31');
    expect(formatVersion('V2026.9.31')).toBe('V2026.9.31');
  });

  it('keeps a pre-release suffix intact', () => {
    expect(formatVersion('2026.9.31-rc.1')).toBe('v2026.9.31-rc.1');
  });

  it('falls back rather than rendering a bare v', () => {
    // `v` on its own reads as a broken version, not as missing data.
    expect(formatVersion(null)).toBe('unknown');
    expect(formatVersion(undefined)).toBe('unknown');
    expect(formatVersion('')).toBe('unknown');
    expect(formatVersion('   ')).toBe('unknown');
    expect(formatVersion(null, '—')).toBe('—');
  });
});

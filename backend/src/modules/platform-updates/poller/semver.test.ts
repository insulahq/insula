import { describe, it, expect } from 'vitest';
import {
  parseVersion,
  isValidVersion,
  compareVersions,
  isNewerVersion,
  isPrerelease,
} from './semver.js';

describe('parseVersion', () => {
  it('parses a stable CalVer version', () => {
    expect(parseVersion('2026.6.3')).toEqual({ major: 2026, minor: 6, patch: 3, prerelease: [] });
  });

  it('strips a leading v and surrounding whitespace', () => {
    expect(parseVersion('  v2026.6.3 ')).toEqual({ major: 2026, minor: 6, patch: 3, prerelease: [] });
  });

  it('parses a prerelease into dot-separated identifiers', () => {
    expect(parseVersion('2026.6.3-rc.1')).toEqual({ major: 2026, minor: 6, patch: 3, prerelease: ['rc', '1'] });
  });

  it('rejects a leading-zero month (ADR-045 Decision 6)', () => {
    expect(parseVersion('2026.06.1')).toBeNull();
  });

  it('rejects a four-part / garbage version', () => {
    expect(parseVersion('1.2.3.4')).toBeNull();
    expect(parseVersion('not-a-version')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });
});

describe('isValidVersion', () => {
  it('accepts valid, rejects invalid', () => {
    expect(isValidVersion('2026.6.10')).toBe(true);
    expect(isValidVersion('0.1.0')).toBe(true);
    expect(isValidVersion('2026.6')).toBe(false);
  });
});

describe('compareVersions', () => {
  it('orders by numeric core (not string sort): 2026.6.10 > 2026.6.9', () => {
    expect(compareVersions('2026.6.10', '2026.6.9')).toBe(1);
    expect(compareVersions('2026.6.9', '2026.6.10')).toBe(-1);
  });

  it('a stable release outranks the same core prerelease (SemVer §11.3)', () => {
    expect(compareVersions('2026.6.3', '2026.6.3-rc.1')).toBe(1);
    expect(compareVersions('2026.6.3-rc.1', '2026.6.3')).toBe(-1);
  });

  it('orders prereleases: numeric identifiers compared numerically', () => {
    expect(compareVersions('2026.6.3-rc.2', '2026.6.3-rc.10')).toBe(-1);
  });

  it('a longer prerelease set outranks its prefix', () => {
    expect(compareVersions('2026.6.3-rc.1.1', '2026.6.3-rc.1')).toBe(1);
  });

  it('equal versions compare 0', () => {
    expect(compareVersions('2026.6.3', '2026.6.3')).toBe(0);
  });

  it('an unparseable version sorts below any valid one (never selected as newest)', () => {
    expect(compareVersions('garbage', '0.0.1')).toBe(-1);
    expect(compareVersions('0.0.1', 'garbage')).toBe(1);
  });
});

describe('isNewerVersion', () => {
  it('is true only when strictly newer', () => {
    expect(isNewerVersion('2026.7.0', '2026.6.9')).toBe(true);
    expect(isNewerVersion('2026.6.9', '2026.6.9')).toBe(false);
    expect(isNewerVersion('2026.6.8', '2026.6.9')).toBe(false);
  });
});

describe('isPrerelease', () => {
  it('detects prerelease identifiers', () => {
    expect(isPrerelease('2026.6.3-rc.1')).toBe(true);
    expect(isPrerelease('2026.6.3')).toBe(false);
    expect(isPrerelease('garbage')).toBe(false);
  });
});

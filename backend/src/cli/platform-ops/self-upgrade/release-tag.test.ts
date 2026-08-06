/**
 * The rule under test decides which GitHub release a node downloads its own
 * binary from. Both directions are dangerous:
 *  - too eager, and `2026.8.3-rc.4` becomes `2026.8.3` — a different release, or
 *    none at all;
 *  - too shy, and DEV's `2026.8.2-d847808` 404s and the node keeps a stale
 *    binary forever, which is exactly the state this fixes.
 */
import { describe, it, expect } from 'vitest';
import { releaseTagFor } from './release-tag.js';

describe('releaseTagFor', () => {
  it('strips the build-deploy sha stamp — the DEV case that 404d', () => {
    expect(releaseTagFor('2026.8.2-d847808')).toBe('2026.8.2');
  });

  it('leaves a plain release untouched', () => {
    expect(releaseTagFor('2026.8.2')).toBe('2026.8.2');
  });

  it('NEVER rewrites a real prerelease — rc.N is its own tag', () => {
    // Mapping this to 2026.8.3 would request a release that may not exist, or
    // silently install a different one.
    expect(releaseTagFor('2026.8.3-rc.4')).toBe('2026.8.3-rc.4');
    expect(releaseTagFor('2026.8.3-rc.10')).toBe('2026.8.3-rc.10');
  });

  it('only strips something that actually looks like a git sha', () => {
    expect(releaseTagFor('2026.8.2-beta')).toBe('2026.8.2-beta');
    expect(releaseTagFor('2026.8.2-hotfix')).toBe('2026.8.2-hotfix');
    expect(releaseTagFor('2026.8.2-d84780')).toBe('2026.8.2-d84780'); // 6 chars: too short
  });

  it('does not strip a multi-identifier prerelease that merely ends in a sha', () => {
    expect(releaseTagFor('2026.8.2-rc.1.d847808')).toBe('2026.8.2-rc.1.d847808');
  });

  it('handles a full 40-char sha and a leading v', () => {
    expect(releaseTagFor(`2026.8.2-${'a'.repeat(40)}`)).toBe('2026.8.2');
    expect(releaseTagFor('v2026.8.2-d847808')).toBe('2026.8.2');
  });

  it('passes through anything unparseable rather than inventing a tag', () => {
    expect(releaseTagFor('not-a-version')).toBe('not-a-version');
    expect(releaseTagFor('')).toBe('');
  });

  it('is idempotent', () => {
    expect(releaseTagFor(releaseTagFor('2026.8.2-d847808'))).toBe('2026.8.2');
  });
});

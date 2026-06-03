import { describe, it, expect } from 'vitest';
import { selectRelease } from './select.js';
import type { GithubRelease } from './types.js';

function rel(tagName: string, over: Partial<GithubRelease> = {}): GithubRelease {
  return { tagName, draft: false, prerelease: false, assets: [], ...over };
}

describe('selectRelease', () => {
  it('returns null when there are no releases', () => {
    expect(selectRelease([], { includePrereleases: false })).toBeNull();
  });

  it('picks the newest stable release by semver (not string sort)', () => {
    const r = selectRelease(
      [rel('v2026.6.9'), rel('v2026.6.10'), rel('v2026.6.2')],
      { includePrereleases: false },
    );
    expect(r?.tagName).toBe('v2026.6.10');
  });

  it('excludes drafts', () => {
    const r = selectRelease(
      [rel('v2026.7.0', { draft: true }), rel('v2026.6.5')],
      { includePrereleases: false },
    );
    expect(r?.tagName).toBe('v2026.6.5');
  });

  it('excludes API-flagged prereleases when the flag is off', () => {
    const r = selectRelease(
      [rel('v2026.7.0', { prerelease: true }), rel('v2026.6.5')],
      { includePrereleases: false },
    );
    expect(r?.tagName).toBe('v2026.6.5');
  });

  it('excludes tags that parse as prerelease even if prerelease:false (defence in depth)', () => {
    const r = selectRelease(
      [rel('v2026.7.0-rc.1', { prerelease: false }), rel('v2026.6.5')],
      { includePrereleases: false },
    );
    expect(r?.tagName).toBe('v2026.6.5');
  });

  it('includes prereleases when the flag is on, and a stable outranks its prerelease', () => {
    const r = selectRelease(
      [rel('v2026.7.0-rc.1', { prerelease: true }), rel('v2026.7.0')],
      { includePrereleases: true },
    );
    expect(r?.tagName).toBe('v2026.7.0');
  });

  it('picks the newest prerelease when only prereleases exist and the flag is on', () => {
    const r = selectRelease(
      [rel('v2026.7.0-rc.1', { prerelease: true }), rel('v2026.7.0-rc.2', { prerelease: true })],
      { includePrereleases: true },
    );
    expect(r?.tagName).toBe('v2026.7.0-rc.2');
  });

  it('ignores tags that are not valid versions', () => {
    const r = selectRelease(
      [rel('nightly'), rel('latest'), rel('v2026.6.1')],
      { includePrereleases: false },
    );
    expect(r?.tagName).toBe('v2026.6.1');
  });

  it('returns null when all releases are ineligible', () => {
    expect(
      selectRelease([rel('v2026.7.0', { prerelease: true }), rel('garbage')], { includePrereleases: false }),
    ).toBeNull();
  });
});

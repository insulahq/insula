import { describe, it, expect } from 'vitest';
import { isAllowedAssetHost } from './index.js';

describe('poller isAllowedAssetHost', () => {
  it('allows github.com and BOTH release-asset CDN hosts (old + new)', () => {
    expect(isAllowedAssetHost('https://github.com/insulahq/insula/releases/download/v1/release-manifest.json')).toBe(true);
    expect(isAllowedAssetHost('https://objects.githubusercontent.com/foo')).toBe(true);
    expect(isAllowedAssetHost('https://release-assets.githubusercontent.com/github-production-release-asset/x?sig=y')).toBe(true);
  });

  it('refuses non-https and off-allowlist hosts (SSRF guard)', () => {
    expect(isAllowedAssetHost('http://github.com/x')).toBe(false);
    expect(isAllowedAssetHost('https://evil.com/x')).toBe(false);
    expect(isAllowedAssetHost('https://release-assets.githubusercontent.com.evil.com/x')).toBe(false);
    expect(isAllowedAssetHost('http://169.254.169.254/latest/meta-data')).toBe(false);
  });
});

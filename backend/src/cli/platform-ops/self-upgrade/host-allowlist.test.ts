import { describe, it, expect } from 'vitest';
import { isAllowedHost } from './index.js';

describe('self-upgrade isAllowedHost', () => {
  it('allows github.com and BOTH release-asset CDN hosts (old + new)', () => {
    expect(isAllowedHost('https://github.com/insulahq/insula/releases/download/v1/platform-ops-linux-amd64')).toBe(true);
    expect(isAllowedHost('https://objects.githubusercontent.com/foo')).toBe(true);
    // the 2025 CDN host — the regression this fix addresses
    expect(isAllowedHost('https://release-assets.githubusercontent.com/github-production-release-asset/x?sig=y')).toBe(true);
  });

  it('refuses non-https and off-allowlist hosts (SSRF guard)', () => {
    expect(isAllowedHost('http://github.com/x')).toBe(false); // not https
    expect(isAllowedHost('https://evil.com/x')).toBe(false);
    expect(isAllowedHost('https://githubusercontent.com.evil.com/x')).toBe(false);
    expect(isAllowedHost('https://release-assets.githubusercontent.com.evil.com/x')).toBe(false);
    expect(isAllowedHost('not a url')).toBe(false);
  });
});

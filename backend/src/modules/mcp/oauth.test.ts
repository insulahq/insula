import { describe, expect, it } from 'vitest';
import { acceptableRedirectUri, parseScopeParam, pkceS256 } from './oauth.js';

describe('redirect URIs a client may register', () => {
  it('allows https and loopback http', () => {
    expect(acceptableRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(acceptableRedirectUri('http://localhost:33418/callback')).toBe(true);
    expect(acceptableRedirectUri('http://127.0.0.1:8080/cb')).toBe(true);
    expect(acceptableRedirectUri('cursor://anysphere.cursor-mcp/oauth/callback')).toBe(true);
  });

  it('refuses plain http elsewhere, fragments, and script-ish schemes', () => {
    expect(acceptableRedirectUri('http://evil.example.test/cb')).toBe(false);
    expect(acceptableRedirectUri('https://x.example.test/cb#frag')).toBe(false);
    expect(acceptableRedirectUri('javascript:alert(1)')).toBe(false);
    expect(acceptableRedirectUri('data:text/html,hi')).toBe(false);
    expect(acceptableRedirectUri('file:///etc/passwd')).toBe(false);
    expect(acceptableRedirectUri('not a url')).toBe(false);
  });
});

describe('PKCE', () => {
  it('matches the RFC 7636 appendix B vector', () => {
    expect(pkceS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('the scope parameter', () => {
  it('defaults to read, de-duplicates, and refuses unknown scopes', () => {
    expect(parseScopeParam(undefined)).toEqual(['read']);
    expect(parseScopeParam('read write write')).toEqual(['read', 'write']);
    expect(parseScopeParam('read admin')).toBeNull();
  });
});

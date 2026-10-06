import { describe, expect, it } from 'vitest';
import { agentEndpointsMatch } from './ingress-proxy-manager.js';

describe('the agent bypass route on a proxy-protected admin host', () => {
  const rule = agentEndpointsMatch('admin.example.test');

  it('is pinned to the admin host', () => {
    expect(rule.startsWith('Host(`admin.example.test`) && (')).toBe(true);
  });

  it('lets API-token requests, the MCP endpoint, OAuth and discovery through', () => {
    expect(rule).toContain('HeaderRegexp(`Authorization`, `^Bearer insula_(pat|oat)_`)');
    expect(rule).toContain('Path(`/api/v1/mcp`)');
    expect(rule).toContain('PathPrefix(`/api/v1/oauth/`)');
    expect(rule).toContain('PathPrefix(`/.well-known/oauth-protected-resource`)');
    expect(rule).toContain('Path(`/.well-known/oauth-authorization-server`)');
  });

  it('keeps the consent API and plain browser traffic behind the proxy', () => {
    expect(rule).toContain('!PathPrefix(`/api/v1/oauth/requests`)');
    // The API is only bypassed WITH a platform token — never by path alone.
    expect(rule).not.toMatch(/\|\| PathPrefix\(`\/api\/v1\/`\)/);
    expect(rule).toMatch(/\(PathPrefix\(`\/api\/v1\/`\) && HeaderRegexp/);
  });
});

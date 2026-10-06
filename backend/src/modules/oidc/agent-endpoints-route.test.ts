import { describe, expect, it } from 'vitest';
import {
  AGENT_TOKEN_AUTH_MIDDLEWARE,
  agentEndpointsMatch,
  buildAgentEndpointsResources,
  patApiMatch,
} from './ingress-proxy-manager.js';

const HOST = 'admin.example.test';

describe('the agent routes on a proxy-protected admin host', () => {
  const selfAuth = agentEndpointsMatch(HOST);
  const pat = patApiMatch(HOST);

  it('are pinned to the admin host', () => {
    expect(selfAuth.startsWith('Host(`admin.example.test`) && (')).toBe(true);
    expect(pat.startsWith('Host(`admin.example.test`) && ')).toBe(true);
  });

  it('let the MCP endpoint, OAuth and discovery through on their own — by exact path', () => {
    for (const p of [
      '/api/v1/mcp', '/api/v1/oauth/register', '/api/v1/oauth/authorize', '/api/v1/oauth/token',
      '/api/v1/oauth/revoke', '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/api/v1/mcp', '/.well-known/oauth-authorization-server',
    ]) expect(selfAuth).toContain(`Path(\`${p}\`)`);
  });

  it('keep the consent API and plain browser traffic behind the proxy', () => {
    // No prefix match at all: `/api/v1/oauth//requests/x` escaped a
    // prefix-minus-exclusion rule at the edge and was merged back by nginx.
    expect(selfAuth).not.toContain('PathPrefix');
    expect(selfAuth).not.toContain('/requests');
    expect(selfAuth).not.toContain('Authorization');
  });

  it('route the API only for a PAT-shaped header — OAuth tokens are MCP-only', () => {
    expect(pat).toContain('PathPrefix(`/api/v1/`)');
    expect(pat).toContain('HeaderRegexp(`Authorization`, `^Bearer insula_pat_`)');
    expect(pat).not.toContain('oat');
  });

  it('check the PAT at the edge: ForwardAuth on the API route, none on the self-authenticating one', () => {
    const { middleware, ingressRoute } = buildAgentEndpointsResources(HOST);
    const routes = ingressRoute.spec.routes;
    const patRoute = routes.find((r) => r.match === pat);
    const selfRoute = routes.find((r) => r.match === selfAuth);
    expect(patRoute?.middlewares).toEqual([{ name: AGENT_TOKEN_AUTH_MIDDLEWARE, namespace: 'platform' }]);
    expect(selfRoute?.middlewares ?? []).toEqual([]);
    expect(routes).toHaveLength(2);

    expect(middleware.metadata.name).toBe(AGENT_TOKEN_AUTH_MIDDLEWARE);
    const fwd = (middleware.spec as { forwardAuth: { address: string; authRequestHeaders: string[]; trustForwardHeader: boolean } }).forwardAuth;
    expect(fwd.address).toBe('http://platform-api.platform.svc.cluster.local:3000/api/v1/internal/agent-token-check');
    expect(fwd.authRequestHeaders).toEqual(['Authorization']);
    expect(fwd.trustForwardHeader).toBe(false);
  });
});

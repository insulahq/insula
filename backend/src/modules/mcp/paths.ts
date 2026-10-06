/**
 * Public URLs of the agent endpoints. The MCP endpoint and the OAuth server
 * live on the ADMIN panel host — agent access is an admin-panel function —
 * under the API prefix the panel already proxies, plus the two RFC discovery
 * documents at the host root.
 */
import { adminHost, type BaseDomainConfig } from '../../config/domains.js';

export const MCP_PATH = '/api/v1/mcp';
export const OAUTH_PREFIX = '/api/v1/oauth';
export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';
export const AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server';
/** Cluster-internal: Traefik ForwardAuth asks whether a bearer is a live PAT. */
export const AGENT_TOKEN_CHECK_PATH = '/api/v1/internal/agent-token-check';
/**
 * Every path that authenticates itself, EXACTLY — a proxy-protected admin host
 * routes these past OAuth2 Proxy (oidc/ingress-proxy-manager.ts). Exact paths,
 * never a prefix with an exclusion: `/api/v1/oauth//requests` is not a prefix of
 * `/api/v1/oauth/requests` at the edge, yet nginx merges the slashes behind it.
 * mcp-flow.test.ts holds this list equal to the skipAuth routes registered.
 */
export const SELF_AUTHENTICATING_PATHS: readonly string[] = [
  MCP_PATH,
  `${OAUTH_PREFIX}/register`,
  `${OAUTH_PREFIX}/authorize`,
  `${OAUTH_PREFIX}/token`,
  `${OAUTH_PREFIX}/revoke`,
  PROTECTED_RESOURCE_METADATA_PATH,
  `${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH}`,
  AUTHORIZATION_SERVER_METADATA_PATH,
];
/** The admin panel's consent page (SPA route). */
export const CONSENT_PAGE_PATH = '/oauth/consent';

export interface AgentUrls {
  /** https://admin.<apex> — also the OAuth issuer. */
  readonly origin: string;
  /** The MCP endpoint, which is also the OAuth resource identifier (RFC 8707). */
  readonly mcp: string;
  readonly resourceMetadata: string;
}

export function agentUrls(cfg: BaseDomainConfig): AgentUrls {
  const origin = `https://${adminHost(cfg)}`;
  return {
    origin,
    mcp: `${origin}${MCP_PATH}`,
    resourceMetadata: `${origin}${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH}`,
  };
}

/** Paths that answer agents from any origin (see the CORS delegator in app.ts). */
export function isAgentPath(url: string): boolean {
  const path = url.split('?')[0];
  return path === MCP_PATH
    || (path.startsWith(`${OAUTH_PREFIX}/`) && !isConsentApiPath(path))
    || path.startsWith(PROTECTED_RESOURCE_METADATA_PATH)
    || path.startsWith(AUTHORIZATION_SERVER_METADATA_PATH);
}

/**
 * Which OAuth paths answer any origin. The consent API (`/oauth/requests/…`)
 * is called by the admin panel with the user's session and stays behind the
 * panel's own CORS origins.
 */
export function isConsentApiPath(url: string): boolean {
  return url.split('?')[0].startsWith(`${OAUTH_PREFIX}/requests`);
}

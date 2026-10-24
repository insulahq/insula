/**
 * OAuth 2.1 authorization server for MCP clients — one per panel host.
 *
 *   discovery     /.well-known/oauth-protected-resource[/api/v1/mcp]   (RFC 9728)
 *                 /.well-known/oauth-authorization-server               (RFC 8414)
 *   registration  POST /api/v1/oauth/register   — open, public clients    (RFC 7591)
 *   authorize     GET  /api/v1/oauth/authorize  — PKCE S256 only; parks the
 *                 request and sends the browser to that panel's consent page
 *   consent API   GET  /api/v1/oauth/requests/:id, POST …/:id/decision — called
 *                 by the panel with the signed-in user's session
 *   token         POST /api/v1/oauth/token      — authorization_code creates a
 *                 CONNECTION (tokens.ts): a 1-hour access token plus a refresh
 *                 token, renewed with refresh_token (rotated on every use) until
 *                 the connection ends 8 hours after approval
 *   revocation    POST /api/v1/oauth/revoke     (RFC 7009) — ends the connection
 *
 * The admin host (admin.<apex>) issues tokens for the admin MCP endpoint to
 * users holding MCP_ALLOWED_ROLE; the tenant host (tenant.<apex>) issues tokens
 * for the tenant MCP endpoint to tenant users, while the operator keeps tenant
 * agents switched on. Every token names its endpoint (RFC 8707 resource), so a
 * token of one panel is worthless at the other. The token, discovery,
 * registration and revocation endpoints answer in OAuth's own JSON error
 * format — not the platform envelope — because OAuth clients parse them.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  MCP_ALLOWED_ROLE, MCP_SCOPES, mcpConsentDecisionSchema, mcpScopeSchema,
  type McpAudience, type McpConsentRequest, type McpScope,
} from '@insula/api-contracts';
import { mcpConnections, mcpOauthClients, mcpOauthRequests, users } from '../../db/schema.js';
import type { JwtPayload } from '../../middleware/auth.js';
import { authenticate } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import {
  AUTHORIZATION_SERVER_METADATA_PATH, CONSENT_PAGE_PATH, MCP_PATH, OAUTH_PREFIX,
  PROTECTED_RESOURCE_METADATA_PATH, agentUrls, audienceForHost, audienceForResource,
} from './paths.js';
import { tenantAgentsEnabled } from './settings.js';
import {
  createConnection, evictUnapprovedClient, hashSecret, looksLikeToken, refreshConnection,
  resolveToken, revokeByClientToken,
} from './tokens.js';

/** How long a user has to decide, and a client to redeem the code. */
const REQUEST_TTL_MS = 10 * 60_000;
/** Registered clients ever kept; registration refuses beyond this. */
const MAX_CLIENTS = 2000;
const GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;

const oauthError = (reply: FastifyReply, status: number, error: string, description: string) =>
  reply.code(status).header('cache-control', 'no-store').send({ error, error_description: description });

/** https anywhere, or http on a loopback host (native clients, RFC 8252). */
export function acceptableRedirectUri(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  // Private-use schemes of native apps (e.g. cursor://). Never javascript:/data:.
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !['javascript:', 'data:', 'file:', 'vbscript:'].includes(u.protocol);
}

export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function parseScopeParam(raw: unknown): McpScope[] | null {
  const words = typeof raw === 'string' && raw.trim() ? raw.trim().split(/\s+/) : ['read'];
  const scopes: McpScope[] = [];
  for (const w of words) {
    const s = mcpScopeSchema.safeParse(w);
    if (!s.success) return null;
    if (!scopes.includes(s.data)) scopes.push(s.data);
  }
  return scopes;
}

function withParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

const registerSchema = z.object({
  client_name: z.string().trim().min(1).max(200).optional(),
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
}).passthrough();

const authorizeSchema = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1).max(64),
  redirect_uri: z.string().min(1).max(2000),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
  state: z.string().max(2000).optional(),
  scope: z.string().max(100).optional(),
  resource: z.string().max(2000).optional(),
});

const codeGrantSchema = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(1).max(200),
  redirect_uri: z.string().min(1).max(2000),
  client_id: z.string().min(1).max(64),
  code_verifier: z.string().min(43).max(128),
  resource: z.string().max(2000).optional(),
});

const refreshGrantSchema = z.object({
  grant_type: z.literal('refresh_token'),
  refresh_token: z.string().min(1).max(200),
  client_id: z.string().min(1).max(64),
  resource: z.string().max(2000).optional(),
  scope: z.string().max(100).optional(),
});

/**
 * Whether the signed-in caller may approve an agent for `audience`: an admin
 * for the admin endpoint; for the tenant endpoint a tenant user signing in as
 * themselves — never an impersonation session, whose approval would hand staff
 * a free-standing tenant credential that outlives the impersonation and is
 * audited as the tenant (staff agents act on tenants with `asTenant` instead).
 */
export async function assertMayConnect(app: FastifyInstance, user: JwtPayload, audience: McpAudience): Promise<void> {
  if (audience === 'admin') {
    if (user.panel !== 'admin' || user.role !== MCP_ALLOWED_ROLE) {
      throw new ApiError('AGENT_ACCESS_NOT_ALLOWED', 'Only users with the admin role can connect AI agents to the admin panel.', 403);
    }
    return;
  }
  if (user.panel !== 'tenant' || !user.tenantId) {
    throw new ApiError('AGENT_ACCESS_NOT_ALLOWED', 'Sign in to the tenant panel to connect an AI agent to it.', 403);
  }
  if (user.impersonatedBy) {
    throw new ApiError(
      'AGENT_ACCESS_NOT_ALLOWED',
      'An impersonation session cannot connect an AI agent for the tenant. Staff agents act on a tenant through the admin MCP endpoint (asTenant).',
      403,
    );
  }
  if (!(await tenantAgentsEnabled(app.db))) {
    throw new ApiError('TENANT_AGENTS_DISABLED', 'AI agents are switched off for tenant panels on this platform.', 403);
  }
}

export async function mcpOauthRoutes(app: FastifyInstance): Promise<void> {
  const cfg = app.config as never;
  const urlsFor = (request: FastifyRequest) => agentUrls(cfg, audienceForHost(cfg, request.hostname));

  // OAuth clients POST the token / revoke endpoints as a form.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });

  // ── discovery (per panel host) ───────────────────────────────────────────
  const resourceMetadata = async (request: FastifyRequest) => {
    const urls = urlsFor(request);
    return {
      resource: urls.mcp,
      authorization_servers: [urls.origin],
      scopes_supported: [...MCP_SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: urls.audience === 'tenant' ? 'Insula tenant panel (MCP)' : 'Insula admin (MCP)',
    };
  };
  for (const path of [PROTECTED_RESOURCE_METADATA_PATH, `${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH}`]) {
    app.get(path, { config: { skipAuth: true } }, resourceMetadata);
  }
  app.get(AUTHORIZATION_SERVER_METADATA_PATH, { config: { skipAuth: true } }, async (request) => {
    const { origin } = urlsFor(request);
    return {
      issuer: origin,
      authorization_endpoint: `${origin}${OAUTH_PREFIX}/authorize`,
      token_endpoint: `${origin}${OAUTH_PREFIX}/token`,
      registration_endpoint: `${origin}${OAUTH_PREFIX}/register`,
      revocation_endpoint: `${origin}${OAUTH_PREFIX}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: [...GRANT_TYPES],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...MCP_SCOPES],
    };
  });

  // ── dynamic client registration (public clients) ─────────────────────────
  app.post(`${OAUTH_PREFIX}/register`, { config: { skipAuth: true } }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) return oauthError(reply, 400, 'invalid_client_metadata', parsed.error.issues[0].message);
    const meta = parsed.data;
    const bad = meta.redirect_uris.find((u) => !acceptableRedirectUri(u));
    if (bad) return oauthError(reply, 400, 'invalid_redirect_uri', `redirect_uri not allowed: ${bad}`);
    if (meta.grant_types && meta.grant_types.some((g) => !(GRANT_TYPES as readonly string[]).includes(g))) {
      return oauthError(reply, 400, 'invalid_client_metadata', 'only the authorization_code and refresh_token grants are supported');
    }
    const [{ n }] = await app.db.select({ n: sql<number>`count(*)::int` }).from(mcpOauthClients);
    if (n >= MAX_CLIENTS && !(await evictUnapprovedClient(app.db))) {
      return oauthError(reply, 400, 'invalid_client_metadata', 'client registration is full');
    }
    const id = `mcp_${randomBytes(16).toString('hex')}`;
    const name = meta.client_name ?? 'Unnamed MCP client';
    await app.db.insert(mcpOauthClients).values({ id, name, redirectUris: meta.redirect_uris });
    return reply.code(201).header('cache-control', 'no-store').send({
      client_id: id,
      client_name: name,
      redirect_uris: meta.redirect_uris,
      grant_types: [...GRANT_TYPES],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_id_issued_at: Math.floor(Date.now() / 1000),
    });
  });

  // ── authorize: park the request, send the browser to the consent page ────
  app.get(`${OAUTH_PREFIX}/authorize`, { config: { skipAuth: true } }, async (request, reply) => {
    const urls = urlsFor(request);
    const q = request.query as Record<string, unknown>;
    const clientId = typeof q.client_id === 'string' ? q.client_id : '';
    const redirectUri = typeof q.redirect_uri === 'string' ? q.redirect_uri : '';
    const [client] = clientId
      ? await app.db.select().from(mcpOauthClients).where(eq(mcpOauthClients.id, clientId)).limit(1)
      : [];
    // An unknown client or a redirect it never registered must NOT be
    // redirected to (that would make this an open redirector).
    if (!client || !client.redirectUris.includes(redirectUri)) {
      return oauthError(reply, 400, 'invalid_request', 'unknown client_id or unregistered redirect_uri');
    }
    const state = typeof q.state === 'string' ? q.state : undefined;
    const parsed = authorizeSchema.safeParse(q);
    if (!parsed.success) {
      return reply.redirect(withParams(redirectUri, {
        error: 'invalid_request', error_description: parsed.error.issues[0].message, state,
      }));
    }
    if (parsed.data.resource && parsed.data.resource !== urls.mcp) {
      return reply.redirect(withParams(redirectUri, { error: 'invalid_target', error_description: `resource must be ${urls.mcp}`, state }));
    }
    const scopes = parseScopeParam(parsed.data.scope);
    if (!scopes) return reply.redirect(withParams(redirectUri, { error: 'invalid_scope', state }));
    const id = randomBytes(24).toString('base64url');
    await app.db.insert(mcpOauthRequests).values({
      id, clientId, redirectUri, state: state ?? null, codeChallenge: parsed.data.code_challenge,
      resource: urls.mcp, requestedScopes: scopes, expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
    });
    return reply.redirect(`${urls.origin}${CONSENT_PAGE_PATH}?request=${encodeURIComponent(id)}`);
  });

  // ── consent API (a panel, with the user's session) ───────────────────────
  const sessionOnly = 'An API token cannot approve agent access — sign in to the panel.';

  async function pendingRequest(id: string) {
    const [row] = await app.db
      .select({
        req: mcpOauthRequests,
        clientName: mcpOauthClients.name,
        clientCreatedAt: mcpOauthClients.createdAt,
      })
      .from(mcpOauthRequests)
      .innerJoin(mcpOauthClients, eq(mcpOauthClients.id, mcpOauthRequests.clientId))
      .where(and(eq(mcpOauthRequests.id, id), isNull(mcpOauthRequests.userId), gt(mcpOauthRequests.expiresAt, new Date())))
      .limit(1);
    const audience = row ? audienceForResource(cfg, row.req.resource) : null;
    if (!row || !audience) {
      throw new ApiError('AUTHORIZATION_REQUEST_NOT_FOUND', 'This authorization request has expired or was already answered.', 404);
    }
    return { ...row, audience };
  }

  app.get(`${OAUTH_PREFIX}/requests/:id`, {
    onRequest: [authenticate],
    config: { apiTokenForbidden: sessionOnly },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const { req, audience, clientName, clientCreatedAt } = await pendingRequest(id);
    await assertMayConnect(app, request.user, audience);
    // Has THIS user approved this client before? Asked per user: a client
    // anyone may register would otherwise lose the first-time warning for
    // everyone once its author approved it themselves.
    const [prior] = await app.db.select({ id: mcpConnections.id }).from(mcpConnections)
      .where(and(eq(mcpConnections.clientId, req.clientId), eq(mcpConnections.userId, request.user.sub)))
      .limit(1);
    const body: McpConsentRequest = {
      id: req.id,
      clientName,
      audience,
      redirectHost: new URL(req.redirectUri).host || req.redirectUri,
      requestedScopes: req.requestedScopes.filter((s): s is McpScope => mcpScopeSchema.safeParse(s).success),
      expiresAt: req.expiresAt.toISOString(),
      clientRegisteredAt: clientCreatedAt.toISOString(),
      clientApprovedBefore: prior !== undefined,
    };
    return success(body);
  });

  app.post(`${OAUTH_PREFIX}/requests/:id/decision`, {
    onRequest: [authenticate],
    config: { apiTokenForbidden: sessionOnly },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = mcpConsentDecisionSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    const { req, audience } = await pendingRequest(id);
    await assertMayConnect(app, request.user, audience);
    const state = req.state ?? undefined;
    if (!parsed.data.approve) {
      await app.db.delete(mcpOauthRequests).where(eq(mcpOauthRequests.id, id));
      return success({ redirectTo: withParams(req.redirectUri, { error: 'access_denied', state }) });
    }
    const granted = parsed.data.scopes.filter((s) => req.requestedScopes.includes(s));
    if (granted.length === 0) throw new ApiError('INVALID_FIELD_VALUE', 'Approve at least one of the requested scopes.', 400);
    const code = randomBytes(32).toString('base64url');
    const claimed = await app.db.update(mcpOauthRequests)
      .set({ userId: request.user.sub, grantedScopes: granted, codeHash: hashSecret(code) })
      .where(and(eq(mcpOauthRequests.id, id), isNull(mcpOauthRequests.userId)))
      .returning({ id: mcpOauthRequests.id });
    if (claimed.length === 0) throw new ApiError('AUTHORIZATION_REQUEST_NOT_FOUND', 'This authorization request was already answered.', 409);
    return success({ redirectTo: withParams(req.redirectUri, { code, state }) });
  });

  // ── token ────────────────────────────────────────────────────────────────
  const tokenResponse = (reply: FastifyReply, issued: { access: { token: string; expiresIn: number }; refreshToken: string }, scopes: readonly McpScope[]) =>
    reply.header('cache-control', 'no-store').send({
      access_token: issued.access.token,
      token_type: 'Bearer',
      expires_in: issued.access.expiresIn,
      refresh_token: issued.refreshToken,
      scope: scopes.join(' '),
    });

  /**
   * The approving user may still connect an agent to `audience` — checked
   * again at redemption, since a role, tenant or switch can change in the ten
   * minutes a code lives. Returns the tenant a tenant connection belongs to.
   */
  async function connectableTenant(userId: string, audience: McpAudience): Promise<{ ok: boolean; tenantId: string | null }> {
    const [u] = await app.db.select({ status: users.status, panel: users.panel, role: users.roleName, tenantId: users.tenantId })
      .from(users).where(eq(users.id, userId)).limit(1);
    if (!u || u.status !== 'active') return { ok: false, tenantId: null };
    if (audience === 'admin') return { ok: u.panel === 'admin' && u.role === MCP_ALLOWED_ROLE, tenantId: null };
    const ok = u.panel === 'tenant' && u.tenantId !== null && await tenantAgentsEnabled(app.db);
    return { ok, tenantId: u.tenantId };
  }

  app.post(`${OAUTH_PREFIX}/token`, { config: { skipAuth: true } }, async (request, reply) => {
    const grant = (request.body as { grant_type?: unknown } | null)?.grant_type;
    if (grant === 'refresh_token') {
      const parsed = refreshGrantSchema.safeParse(request.body);
      if (!parsed.success) return oauthError(reply, 400, 'invalid_request', parsed.error.issues[0].message);
      const result = await refreshConnection(app.db, parsed.data.refresh_token, parsed.data.client_id);
      if (!result.ok) return oauthError(reply, 400, 'invalid_grant', result.reason);
      if (parsed.data.resource && parsed.data.resource !== result.resource) {
        return oauthError(reply, 400, 'invalid_target', `resource must be ${result.resource}`);
      }
      return tokenResponse(reply, result.issued, result.scopes);
    }
    if (grant !== undefined && grant !== 'authorization_code') {
      return oauthError(reply, 400, 'unsupported_grant_type', 'only authorization_code and refresh_token are supported');
    }
    const parsed = codeGrantSchema.safeParse(request.body ?? {});
    if (!parsed.success) return oauthError(reply, 400, 'invalid_request', parsed.error.issues[0].message);
    const t = parsed.data;
    // Redeem exactly once: the UPDATE … WHERE code_used_at IS NULL is the lock.
    const [req] = await app.db.update(mcpOauthRequests)
      .set({ codeUsedAt: new Date() })
      .where(and(
        eq(mcpOauthRequests.codeHash, hashSecret(t.code)),
        isNull(mcpOauthRequests.codeUsedAt),
        gt(mcpOauthRequests.expiresAt, new Date()),
      ))
      .returning();
    if (!req || !req.userId || !req.grantedScopes) return oauthError(reply, 400, 'invalid_grant', 'invalid or expired code');
    if (t.resource && t.resource !== req.resource) return oauthError(reply, 400, 'invalid_target', `resource must be ${req.resource}`);
    if (req.clientId !== t.client_id || req.redirectUri !== t.redirect_uri) {
      return oauthError(reply, 400, 'invalid_grant', 'code was issued to another client or redirect_uri');
    }
    if (pkceS256(t.code_verifier) !== req.codeChallenge) return oauthError(reply, 400, 'invalid_grant', 'PKCE verification failed');
    const audience = audienceForResource(cfg, req.resource);
    if (!audience) return oauthError(reply, 400, 'invalid_grant', 'invalid or expired code');
    const who = await connectableTenant(req.userId, audience);
    if (!who.ok) return oauthError(reply, 400, 'invalid_grant', 'the approving user can no longer connect an agent here');
    const [client] = await app.db.select().from(mcpOauthClients).where(eq(mcpOauthClients.id, req.clientId)).limit(1);
    const scopes = req.grantedScopes.filter((s): s is McpScope => mcpScopeSchema.safeParse(s).success);
    const issued = await createConnection(app.db, {
      userId: req.userId, tenantId: who.tenantId, clientId: req.clientId, clientName: client?.name ?? 'MCP client',
      audience, scopes, resource: req.resource,
    });
    await app.db.update(mcpOauthClients).set({ lastUsedAt: new Date() }).where(eq(mcpOauthClients.id, req.clientId));
    return tokenResponse(reply, issued, scopes);
  });

  // ── edge check for a proxy-protected admin panel ─────────────────────────
  // Traefik's ForwardAuth asks this before letting a token-bearing API request
  // past OAuth2 Proxy (oidc/ingress-proxy-manager.ts): 204 for a live PAT,
  // 401 for anything else — a header that merely LOOKS like a token gets
  // nothing. Reached only inside the cluster: the panels' nginx refuses
  // /api/v1/internal/ at the edge.
  // Its own bucket (a per-route limit is a separate store): sharing the global
  // one would charge every PAT request twice. 600/min per client still bounds
  // the hash lookups a stream of made-up tokens can cause.
  app.get('/api/v1/internal/agent-token-check', {
    config: { skipAuth: true, rateLimit: { max: 600, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const header = request.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const principal = bearer && looksLikeToken(bearer) === 'pat' ? await resolveToken(app.db, bearer) : null;
    return reply.code(principal ? 204 : 401).send();
  });

  // ── revocation (any client may revoke a token it holds) ──────────────────
  app.post(`${OAUTH_PREFIX}/revoke`, { config: { skipAuth: true } }, async (request, reply) => {
    const token = (request.body as { token?: unknown } | null)?.token;
    if (typeof token === 'string' && token) await revokeByClientToken(app.db, token);
    return reply.code(200).header('cache-control', 'no-store').send({});
  });
}

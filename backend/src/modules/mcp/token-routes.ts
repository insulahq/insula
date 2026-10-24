/**
 * Managing agent access, by a person signed in to a panel:
 *
 *   admin panel   /admin/mcp/tokens        the user's PATs (create, list, revoke)
 *                                          and their own connected agents
 *                 /admin/mcp/connections   every connected agent on the platform,
 *                                          admin and tenant (super_admin, admin)
 *                 /admin/mcp/settings      the switch for tenant agents
 *   tenant panel  /tenants/:tenantId/mcp-agents   the user's own connected
 *                                          agents; a tenant_admin sees and
 *                                          revokes every agent connected to the
 *                                          tenant (under /tenants/:tenantId so the
 *                                          audit log files a revoke under it)
 *
 * Session-only: an API token may not create, list or revoke credentials,
 * otherwise a leaked short-lived token could mint itself a permanent one or
 * hide another. (`/admin/mcp` and these routes are also out of the agents'
 * operation catalog for the same reason.)
 */
import type { FastifyInstance } from 'fastify';
import {
  MCP_ALLOWED_ROLE, createMcpPatSchema, mcpAgentSettingsSchema,
  type CreatedMcpPat, type McpPlatformConnections, type McpTokenList, type TenantMcpAgents,
} from '@insula/api-contracts';
import { authenticate, requirePanel, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import { agentUrls } from './paths.js';
import { setTenantAgentsEnabled, tenantAgentsEnabled } from './settings.js';
import {
  createPat, listConnections, listTokens, revokeConnection, revokeTenantConnections, revokeToken,
  type ConnectionFilter,
} from './tokens.js';

const SESSION_ONLY = 'API tokens are managed by a person signed in to the panel, not by another token.';
const AGENTS_SESSION_ONLY = 'Connected AI agents are managed by a person signed in to the panel, not by an agent.';

export async function mcpTokenRoutes(app: FastifyInstance): Promise<void> {
  const cfg = app.config as never;
  app.addHook('onRequest', authenticate);

  // ── admin panel: the signed-in user's own ────────────────────────────────
  app.get('/admin/mcp/tokens', {
    onRequest: [requirePanel('admin')],
    config: { apiTokenForbidden: SESSION_ONLY },
  }, async (request) => {
    const canUse = request.user.role === MCP_ALLOWED_ROLE;
    const body: McpTokenList = {
      tokens: canUse ? await listTokens(app.db, request.user.sub) : [],
      connections: await listConnections(app.db, { userId: request.user.sub }),
      endpoint: agentUrls(cfg, 'admin').mcp,
      canUse,
    };
    return success(body);
  });

  app.post('/admin/mcp/tokens', {
    onRequest: [requirePanel('admin')],
    config: { apiTokenForbidden: SESSION_ONLY },
  }, async (request, reply) => {
    if (request.user.role !== MCP_ALLOWED_ROLE) {
      throw new ApiError('AGENT_ACCESS_NOT_ALLOWED', 'Only users with the admin role can create API tokens.', 403);
    }
    const parsed = createMcpPatSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ApiError('INVALID_FIELD_VALUE', `${issue.path.join('.') || 'body'}: ${issue.message}`, 400);
    }
    const created = await createPat(app.db, { userId: request.user.sub, ...parsed.data });
    const body: CreatedMcpPat = { ...created.row, token: created.token };
    return reply.code(201).send(success(body));
  });

  app.delete('/admin/mcp/tokens/:id', {
    onRequest: [requirePanel('admin')],
    config: { apiTokenForbidden: SESSION_ONLY },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const revoked = await revokeToken(app.db, request.user.sub, id);
    if (!revoked) throw new ApiError('TOKEN_NOT_FOUND', 'No such token of yours.', 404);
    return success({ revoked: true });
  });

  // ── admin panel: every connected agent (security view) ───────────────────
  app.get('/admin/mcp/connections', {
    onRequest: [requirePanel('admin'), requireRole('super_admin', 'admin')],
    config: { apiTokenForbidden: AGENTS_SESSION_ONLY },
  }, async () => {
    const body: McpPlatformConnections = {
      connections: await listConnections(app.db, { all: true }),
      tenantAgentsEnabled: await tenantAgentsEnabled(app.db),
    };
    return success(body);
  });

  /** Any connection for super_admin/admin — their own included (User Settings uses this too). */
  app.delete('/admin/mcp/connections/:id', {
    onRequest: [requirePanel('admin')],
    config: { apiTokenForbidden: AGENTS_SESSION_ONLY },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const filter: ConnectionFilter = ['super_admin', 'admin'].includes(request.user.role)
      ? { all: true }
      : { userId: request.user.sub };
    const revoked = await revokeConnection(app.db, id, filter);
    if (!revoked) throw new ApiError('CONNECTION_NOT_FOUND', 'No such connected agent, or it has already ended.', 404);
    request.log.info({ connectionId: id, by: request.user.sub }, 'mcp: connection revoked');
    return success({ revoked: true });
  });

  app.patch('/admin/mcp/settings', {
    onRequest: [requirePanel('admin'), requireRole('super_admin', 'admin')],
    config: { apiTokenForbidden: AGENTS_SESSION_ONLY },
  }, async (request) => {
    const parsed = mcpAgentSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ApiError('INVALID_FIELD_VALUE', `${issue.path.join('.') || 'body'}: ${issue.message}`, 400);
    }
    await setTenantAgentsEnabled(app.db, parsed.data.tenantAgentsEnabled);
    // Off means off now — not when each agent's hour runs out.
    const disconnected = parsed.data.tenantAgentsEnabled ? 0 : await revokeTenantConnections(app.db);
    request.log.info({ tenantAgentsEnabled: parsed.data.tenantAgentsEnabled, disconnected, by: request.user.sub }, 'mcp: tenant agents switched');
    return success({ tenantAgentsEnabled: parsed.data.tenantAgentsEnabled, disconnected });
  });

  // ── tenant panel ─────────────────────────────────────────────────────────
  /** What a tenant user may see and revoke: their own, or (tenant_admin) the whole tenant's. */
  function tenantFilter(user: { sub: string; role: string; tenantId?: string }): { filter: ConnectionFilter; view: 'own' | 'tenant' } {
    if (!user.tenantId) throw new ApiError('CLIENT_ACCESS_DENIED', 'Client-panel tokens must carry a tenantId claim', 403);
    return user.role === 'tenant_admin'
      ? { filter: { tenantId: user.tenantId }, view: 'tenant' }
      : { filter: { userId: user.sub }, view: 'own' };
  }

  app.get('/tenants/:tenantId/mcp-agents', {
    onRequest: [requirePanel('tenant'), requireTenantAccess()],
    config: { apiTokenForbidden: AGENTS_SESSION_ONLY },
  }, async (request) => {
    const { filter, view } = tenantFilter(request.user);
    const enabled = await tenantAgentsEnabled(app.db);
    const body: TenantMcpAgents = {
      endpoint: agentUrls(cfg, 'tenant').mcp,
      enabled,
      canConnect: enabled && !request.user.impersonatedBy,
      view,
      connections: await listConnections(app.db, filter),
    };
    return success(body);
  });

  app.delete('/tenants/:tenantId/mcp-agents/:id', {
    onRequest: [requirePanel('tenant'), requireTenantAccess()],
    config: { apiTokenForbidden: AGENTS_SESSION_ONLY },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const { filter } = tenantFilter(request.user);
    const revoked = await revokeConnection(app.db, id, filter);
    if (!revoked) throw new ApiError('CONNECTION_NOT_FOUND', 'No such connected agent, or it has already ended.', 404);
    request.log.info({ connectionId: id, by: request.user.sub, impersonatedBy: request.user.impersonatedBy }, 'mcp: connection revoked');
    return success({ revoked: true });
  });
}

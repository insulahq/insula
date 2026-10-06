/**
 * The signed-in user's own API tokens: PATs (create, list, revoke) and the
 * OAuth tokens MCP clients hold on their behalf (list, revoke).
 *
 * Session-only: an API token may not create or list tokens, otherwise a leaked
 * short-lived token could mint itself a permanent one.
 */
import type { FastifyInstance } from 'fastify';
import {
  MCP_ALLOWED_ROLE, createMcpPatSchema, type CreatedMcpPat, type McpTokenList,
} from '@insula/api-contracts';
import { authenticate, requirePanel } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import { agentUrls } from './paths.js';
import { createPat, listTokens, revokeToken } from './tokens.js';

const SESSION_ONLY = 'API tokens are managed by a person signed in to the panel, not by another token.';

export async function mcpTokenRoutes(app: FastifyInstance): Promise<void> {
  const urls = agentUrls(app.config as never);
  app.addHook('onRequest', authenticate);

  app.get('/admin/mcp/tokens', {
    onRequest: [requirePanel('admin')],
    config: { apiTokenForbidden: SESSION_ONLY },
  }, async (request) => {
    const canUse = request.user.role === MCP_ALLOWED_ROLE;
    const body: McpTokenList = {
      tokens: canUse ? await listTokens(app.db, request.user.sub) : [],
      endpoint: urls.mcp,
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
}

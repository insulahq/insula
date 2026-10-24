/**
 * The MCP endpoint: POST /api/v1/mcp (Streamable HTTP, stateless), on each
 * panel host — the admin panel's for admins, the tenant panel's for tenant
 * users. The host decides which endpoint a request is; the token must have
 * been issued for exactly that endpoint (its RFC 8707 resource), so an admin
 * token is refused on the tenant host and the other way round.
 *
 * Every request authenticates on its own with a bearer API token — an OAuth
 * access token issued for this endpoint, or (admin only) a PAT. Without one
 * the answer is 401 with a `WWW-Authenticate` header naming the
 * protected-resource metadata, which is how an MCP client discovers where to
 * sign in (RFC 9728).
 *
 * The tools are views of the operation catalog (tools.ts); calling one runs the
 * route itself (executor.ts).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpAudience } from '@insula/api-contracts';
import type { OperationCatalog } from './catalog.js';
import { normalizeKey } from './catalog.js';
import { MCP_PATH, agentUrls, audienceForHost } from './paths.js';
import { looksLikeToken, resolveToken, type TokenPrincipal } from './tokens.js';
import {
  describeOperation, inputSchemaFor, resolveCoreTools, searchOperations, tenantVisible, type ResolvedTool,
} from './tools.js';
import { executeOperation, OperationInputError, type OperationInput } from './executor.js';
import { META_TOOLS, TENANT_META_TOOLS } from './meta-tools.js';

const SERVER_INFO: Record<McpAudience, { name: string; version: string }> = {
  admin: { name: 'insula-admin', version: '1.0.0' },
  tenant: { name: 'insula-tenant', version: '1.0.0' },
};

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function text(value: unknown, isError = false): ToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError } : {}) };
}

function argsOf(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
}

function objectArg(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}

async function runCall(
  app: FastifyInstance, principal: TokenPrincipal, catalog: OperationCatalog,
  key: string, input: OperationInput, clientIp: string,
): Promise<ToolResult> {
  const op = catalog.get(normalizeKey(key));
  if (!op) return text(`Unknown operation "${key}". Use find_operations to search.`, true);
  try {
    const res = await executeOperation(app, principal, op, input, clientIp);
    return text({ status: res.status, ok: res.ok, ...(res.truncated ? { truncated: true } : {}), body: res.body }, !res.ok);
  } catch (err) {
    if (err instanceof OperationInputError) return text(err.message, true);
    throw err;
  }
}

function buildServer(
  app: FastifyInstance, catalog: OperationCatalog, coreTools: readonly ResolvedTool[],
  principal: TokenPrincipal, clientIp: string,
): Server {
  const audience = principal.audience;
  const server = new Server(SERVER_INFO[audience], { capabilities: { tools: {} } });
  const metaTools = audience === 'tenant' ? TENANT_META_TOOLS : META_TOOLS;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...coreTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      ...metaTools.map((t) => ({ ...t, inputSchema: { ...t.inputSchema } })),
    ] as never,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = argsOf(req.params.arguments);

    if (name === 'find_operations') {
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 25));
      const hits = searchOperations(catalog, typeof args.query === 'string' ? args.query : '', limit, audience);
      return text(hits.map((op) => ({
        operation: op.key, summary: op.summary, scope: op.scope,
        ...(audience === 'admin' ? { tenantPanelOnly: op.panel === 'tenant' } : {}),
      })));
    }
    if (name === 'describe_operation') {
      const op = catalog.get(normalizeKey(String(args.operation ?? '')));
      if (!op || (audience === 'tenant' && !tenantVisible(op))) return text(`Unknown operation "${String(args.operation)}".`, true);
      return text({ ...describeOperation(op), toolInputSchema: inputSchemaFor(op, undefined, audience) });
    }
    if (name === 'call_operation') {
      return runCall(app, principal, catalog, String(args.operation ?? ''), {
        pathParams: objectArg(args.pathParams) as Record<string, string> | undefined,
        query: objectArg(args.query),
        body: args.body,
        asTenant: typeof args.asTenant === 'string' && args.asTenant ? args.asTenant : undefined,
      }, clientIp);
    }

    const tool = coreTools.find((t) => t.name === name);
    if (!tool) return text(`Unknown tool "${name}".`, true);
    if (tool.scope !== 'varies' && !principal.scopes.includes(tool.scope)) {
      return text(`This token does not have the "${tool.scope}" scope ${name} needs.`, true);
    }
    const pathParams: Record<string, string> = {};
    for (const p of tool.operation.pathParams) if (args[p] !== undefined) pathParams[p] = String(args[p]);
    const query = { ...(objectArg(args.query) ?? {}), ...(tool.tool.fixedQuery ?? {}) };
    const hasBody = tool.operation.method !== 'GET' && tool.operation.method !== 'DELETE';
    const body = hasBody ? { ...(objectArg(args.body) ?? {}), ...(tool.tool.fixedBody ?? {}) } : undefined;
    return runCall(app, principal, catalog, tool.operation.key, {
      pathParams, query, body,
      asTenant: typeof args.asTenant === 'string' && args.asTenant ? args.asTenant : undefined,
    }, clientIp);
  });

  return server;
}

export function mcpEndpointRoutes(catalog: OperationCatalog) {
  return async function routes(app: FastifyInstance): Promise<void> {
    const cfg = app.config as never;
    const coreTools: Partial<Record<McpAudience, ResolvedTool[]>> = {};
    const toolsFor = (audience: McpAudience): ResolvedTool[] => {
      coreTools[audience] ??= resolveCoreTools(catalog, (m) => app.log.warn(m), audience);
      return coreTools[audience];
    };
    // The catalog is complete only once every route is registered.
    app.addHook('onReady', async () => {
      toolsFor('admin');
      toolsFor('tenant');
    });

    const challenge = (reply: FastifyReply, resourceMetadata: string, error?: string) => reply
      .code(401)
      .header('www-authenticate', `Bearer resource_metadata="${resourceMetadata}"${error ? `, error="${error}"` : ''}`)
      .send({ error: error ?? 'unauthorized', error_description: 'A bearer API token is required.' });

    async function authenticateAgent(request: FastifyRequest, reply: FastifyReply): Promise<TokenPrincipal | null> {
      const urls = agentUrls(cfg, audienceForHost(cfg, request.hostname));
      const header = request.headers.authorization ?? '';
      const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!bearer || !looksLikeToken(bearer)) {
        await challenge(reply, urls.resourceMetadata, bearer ? 'invalid_token' : undefined);
        return null;
      }
      const principal = await resolveToken(app.db, bearer);
      // A token is only good at the endpoint it was issued for: an OAuth token
      // names it (resource); a PAT is an admin credential.
      const fits = principal !== null && principal.audience === urls.audience
        && (principal.kind === 'pat' || principal.resource === urls.mcp);
      if (!fits) {
        await challenge(reply, urls.resourceMetadata, 'invalid_token');
        return null;
      }
      return principal;
    }

    app.post(MCP_PATH, { config: { skipAuth: true } }, async (request, reply) => {
      const principal = await authenticateAgent(request, reply);
      if (!principal) return reply;
      const server = buildServer(app, catalog, toolsFor(principal.audience), principal, request.ip);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      // Headers hooks already set on the reply (CORS) — a hijacked reply never
      // writes them itself; writeHead merges what setHeader put there.
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) reply.raw.setHeader(name, value as string | number | string[]);
      }
      reply.hijack();
      reply.raw.on('close', () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (err) {
        // After hijack() Fastify neither answers nor times the request out, so
        // a throw here would leave the client waiting on an open socket.
        request.log.error({ err }, 'mcp: request failed');
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { 'content-type': 'application/json' });
          reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
        } else if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
      return reply;
    });

    // Stateless server: no server-initiated stream, no session to end.
    const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) => reply
      .code(405).header('allow', 'POST')
      .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
    app.get(MCP_PATH, { config: { skipAuth: true } }, notAllowed);
    app.delete(MCP_PATH, { config: { skipAuth: true } }, notAllowed);
  };
}

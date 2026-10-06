/**
 * The MCP endpoint: POST /api/v1/mcp (Streamable HTTP, stateless).
 *
 * Every request authenticates on its own with a bearer API token — an OAuth
 * access token issued for this endpoint, or a PAT. Without one the answer is
 * 401 with a `WWW-Authenticate` header naming the protected-resource metadata,
 * which is how an MCP client discovers where to sign in (RFC 9728).
 *
 * The tools are views of the operation catalog (tools.ts); calling one runs the
 * route itself (executor.ts).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { OperationCatalog } from './catalog.js';
import { normalizeKey } from './catalog.js';
import { MCP_PATH, agentUrls } from './paths.js';
import { looksLikeToken, resolveToken, type TokenPrincipal } from './tokens.js';
import {
  describeOperation, inputSchemaFor, resolveCoreTools, searchOperations, type ResolvedTool,
} from './tools.js';
import { executeOperation, OperationInputError, type OperationInput } from './executor.js';

const SERVER_INFO = { name: 'insula-admin', version: '1.0.0' };

const META_TOOLS = [
  {
    name: 'find_operations',
    description: 'Search every operation of the platform API (any function the admin panel has). '
      + 'Returns operation names ("METHOD /path"), what they do, and the scope each needs. '
      + 'Use describe_operation for inputs, call_operation to run one.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for, e.g. "mailbox create" or "backup restore".' },
        limit: { type: 'number', description: 'Maximum results (default 25, max 100).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'describe_operation',
    description: 'Inputs of one operation: path parameters, query and body JSON schemas, required scope and roles.',
    inputSchema: {
      type: 'object',
      properties: { operation: { type: 'string', description: 'e.g. "GET /tenants/:id".' } },
      required: ['operation'],
      additionalProperties: false,
    },
  },
  {
    name: 'call_operation',
    description: 'Run any operation of the platform API. Needs the scope the operation requires '
      + '(read: GET; write: changes; delete: anything irreversible). Set asTenant to act as a tenant '
      + '(impersonation, audited) — required for tenant-panel-only operations.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', description: 'e.g. "POST /tenants/:tenantId/domains".' },
        pathParams: { type: 'object', additionalProperties: { type: ['string', 'number'] } },
        query: { type: 'object', additionalProperties: true },
        body: { description: 'JSON request body.' },
        asTenant: { type: 'string', description: 'Tenant id to act as.' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
  },
] as const;

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
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...coreTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      ...META_TOOLS.map((t) => ({ ...t, inputSchema: { ...t.inputSchema } })),
    ] as never,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = argsOf(req.params.arguments);

    if (name === 'find_operations') {
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 25));
      const hits = searchOperations(catalog, typeof args.query === 'string' ? args.query : '', limit);
      return text(hits.map((op) => ({
        operation: op.key, summary: op.summary, scope: op.scope, tenantPanelOnly: op.panel === 'tenant',
      })));
    }
    if (name === 'describe_operation') {
      const op = catalog.get(normalizeKey(String(args.operation ?? '')));
      if (!op) return text(`Unknown operation "${String(args.operation)}".`, true);
      return text({ ...describeOperation(op), toolInputSchema: inputSchemaFor(op) });
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
    const urls = agentUrls(app.config as never);
    let coreTools: ResolvedTool[] | null = null;
    // The catalog is complete only once every route is registered.
    app.addHook('onReady', async () => {
      coreTools = resolveCoreTools(catalog, (m) => app.log.warn(m));
    });

    const challenge = (reply: FastifyReply, error?: string) => reply
      .code(401)
      .header('www-authenticate', `Bearer resource_metadata="${urls.resourceMetadata}"${error ? `, error="${error}"` : ''}`)
      .send({ error: error ?? 'unauthorized', error_description: 'A bearer API token is required.' });

    async function authenticateAgent(request: FastifyRequest, reply: FastifyReply): Promise<TokenPrincipal | null> {
      const header = request.headers.authorization ?? '';
      const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!bearer || !looksLikeToken(bearer)) {
        await challenge(reply, bearer ? 'invalid_token' : undefined);
        return null;
      }
      const principal = await resolveToken(app.db, bearer);
      // An OAuth token is only good for the resource it was issued for.
      if (!principal || (principal.kind === 'oauth' && principal.resource !== urls.mcp)) {
        await challenge(reply, 'invalid_token');
        return null;
      }
      return principal;
    }

    app.post(MCP_PATH, { config: { skipAuth: true } }, async (request, reply) => {
      const principal = await authenticateAgent(request, reply);
      if (!principal) return reply;
      const server = buildServer(app, catalog, coreTools ?? resolveCoreTools(catalog), principal, request.ip);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      reply.hijack();
      reply.raw.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
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

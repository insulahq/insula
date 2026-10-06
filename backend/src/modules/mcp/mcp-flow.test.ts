/**
 * The agent path end to end, in-process: a real Fastify app with the real
 * authenticate/role guards, scope hook, operation catalog and MCP endpoint —
 * only the token store is faked. Proves that a tool call runs the route
 * itself, that scopes bind on BOTH layers (the tool and the route), that
 * impersonation carries them, that the impersonation ROUTE is closed to
 * tokens (an agent acts as a tenant in-process, never holding a tenant
 * credential), and that a PAT works on the plain REST API.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { z } from 'zod';

const MCP_URL = 'https://admin.example.test/api/v1/mcp';

vi.mock('./tokens.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tokens.js')>();
  const principals: Record<string, unknown> = {
    insula_pat_read: { tokenId: 'pat-r', kind: 'pat', name: 'reader', scopes: ['read'], userId: 'admin-1', role: 'admin', resource: null },
    insula_pat_rw: { tokenId: 'pat-rw', kind: 'pat', name: 'writer', scopes: ['read', 'write'], userId: 'admin-1', role: 'admin', resource: null },
    insula_oat_good: { tokenId: 'oat-1', kind: 'oauth', name: 'Claude', scopes: ['read', 'write', 'delete'], userId: 'admin-1', role: 'admin', resource: MCP_URL },
    insula_oat_elsewhere: { tokenId: 'oat-2', kind: 'oauth', name: 'X', scopes: ['read'], userId: 'admin-1', role: 'admin', resource: 'https://other.example.test/mcp' },
  };
  return { ...actual, resolveToken: vi.fn(async (_db: unknown, secret: string) => principals[secret] ?? null) };
});

vi.mock('../tenants/impersonation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tenants/impersonation.js')>();
  const { ApiError } = await import('../../shared/errors.js');
  return {
    ...actual,
    findImpersonationTarget: vi.fn(async (_db: unknown, tenantId: string) => {
      if (tenantId === 'tenant-gone') throw new ApiError('TENANT_NOT_FOUND', 'Tenant not found', 404);
      return { id: 'tenant-admin-1', email: 'owner@example.test', fullName: 'Owner' };
    }),
  };
});

const { authenticate, requirePanel, requireRole } = await import('../../middleware/auth.js');
const { enforceApiScope } = await import('../../shared/api-scope.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const { collectOperations } = await import('./catalog.js');
const { mcpEndpointRoutes } = await import('./server.js');
const { mcpOauthRoutes } = await import('./oauth.js');
const { AGENT_TOKEN_CHECK_PATH, SELF_AUTHENTICATING_PATHS } = await import('./paths.js');

/** Every route registered with skipAuth — what the edge must agree with. */
const skipAuthUrls = new Set<string>();

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  app.addHook('onRoute', (route) => {
    if ((route.config as { skipAuth?: boolean } | undefined)?.skipAuth) skipAuthUrls.add(route.url);
  });
  await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only-0123456789' });
  app.decorate('db', {} as never);
  app.decorate('config', { PLATFORM_BASE_DOMAIN: 'example.test' } as never);
  app.setErrorHandler(errorHandler);
  const catalog = collectOperations(app);
  app.addHook('preHandler', async (request) => { enforceApiScope(request, 'handler'); });

  await app.register(async (api) => {
    api.addHook('onRequest', authenticate);
    api.get('/things', { onRequest: [requireRole('admin')], schema: { summary: 'List things' } },
      async (request) => ({ data: [{ id: 1 }], actor: request.user.sub }));
    api.post('/things', {
      onRequest: [requireRole('admin')],
      config: { apiBody: z.object({ name: z.string() }) },
    }, async (request) => ({ data: { created: request.body } }));
    api.delete('/things/:id', { onRequest: [requireRole('admin')] }, async (request) => ({ data: { deleted: (request.params as { id: string }).id } }));
    api.post('/things/:id/purge', { onRequest: [requireRole('admin')] }, async () => ({ data: { purged: true } }));
    // Stand-in for the platform's impersonation route, closed to tokens the same way.
    api.post('/admin/impersonate/:tenantId', {
      onRequest: [requireRole('admin')],
      config: { apiTokenForbidden: 'Impersonation hands out a tenant credential.' },
    }, async () => ({ data: { token: 'a-one-hour-tenant-token' } }));
    api.get('/tenant-only', { onRequest: [requirePanel('tenant')] },
      async (request) => ({ data: { tenantId: request.user.tenantId, impersonatedBy: request.user.impersonatedBy } }));
    api.post('/tenant-only', { onRequest: [requirePanel('tenant')] }, async () => ({ data: { wrote: true } }));
    api.post('/auth/whatever', async () => ({ data: 'never via agents' }));
  }, { prefix: '/api/v1' });
  // What @fastify/cors does: a header set on the reply in a hook.
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/api/v1/mcp') reply.header('access-control-allow-origin', '*');
  });
  await app.register(mcpEndpointRoutes(catalog));
  await app.register(mcpOauthRoutes);
  await app.ready();
});

afterAll(async () => { await app.close(); });

let rpcId = 0;
async function rpc(token: string | null, method: string, params?: unknown) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }),
  });
  return res;
}

async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const res = await rpc(token, 'tools/call', { name, arguments: args });
  const body = res.json() as { result: { content: Array<{ text: string }>; isError?: boolean } };
  const textOut = body.result.content[0].text;
  let parsed: unknown = textOut;
  try { parsed = JSON.parse(textOut); } catch { /* plain text */ }
  return { isError: body.result.isError === true, out: parsed as Record<string, unknown> & string };
}

describe('the MCP endpoint', () => {
  it('challenges a caller without a token toward the OAuth metadata', async () => {
    const res = await rpc(null, 'tools/list');
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('resource_metadata="https://admin.example.test/.well-known/oauth-protected-resource/api/v1/mcp"');
  });

  it('refuses an OAuth token issued for another resource', async () => {
    const res = await rpc('insula_oat_elsewhere', 'tools/list');
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('invalid_token');
  });

  it('lists the generic tools for a valid token', async () => {
    const res = await rpc('insula_oat_good', 'tools/list');
    expect(res.statusCode).toBe(200);
    const names = (res.json() as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['find_operations', 'describe_operation', 'call_operation']));
  });

  it('finds operations from the live route table, and never an excluded one', async () => {
    const { out } = await callTool('insula_oat_good', 'find_operations', { query: 'things' });
    const ops = (out as unknown as Array<{ operation: string }>).map((o) => o.operation);
    expect(ops).toEqual(expect.arrayContaining(['GET /things', 'POST /things', 'DELETE /things/:id']));
    const { out: auth } = await callTool('insula_oat_good', 'find_operations', { query: 'auth whatever' });
    expect((auth as unknown as unknown[]).length).toBe(0);
  });

  it('describes an operation with the schema the route declared', async () => {
    const { out } = await callTool('insula_oat_good', 'describe_operation', { operation: 'POST /things' });
    expect(out.scope).toBe('write');
    expect(JSON.stringify(out.bodySchema)).toContain('"name"');
  });

  it('runs the route itself, as the token\'s owner', async () => {
    const { isError, out } = await callTool('insula_oat_good', 'call_operation', { operation: 'GET /things' });
    expect(isError).toBe(false);
    expect((out.body as { actor: string }).actor).toBe('admin-1');
  });

  it('holds a read token to read — refused by the ROUTE, not just the tool', async () => {
    const { isError, out } = await callTool('insula_pat_read', 'call_operation', { operation: 'POST /things', body: { name: 'x' } });
    expect(isError).toBe(true);
    expect(out.status).toBe(403);
    expect(JSON.stringify(out.body)).toContain('INSUFFICIENT_SCOPE');
  });

  it('treats a destructive POST as delete', async () => {
    const { isError, out } = await callTool('insula_pat_rw', 'call_operation', { operation: 'POST /things/:id/purge', pathParams: { id: '7' } });
    expect(isError).toBe(true);
    expect(JSON.stringify(out.body)).toContain('"delete"');
  });

  it('refuses excluded routes even by name', async () => {
    const { isError, out } = await callTool('insula_oat_good', 'call_operation', { operation: 'POST /auth/whatever' });
    expect(isError).toBe(true);
    expect(String(out)).toMatch(/not available to agents/);
  });

  it('acts as a tenant through impersonation, keeping the token\'s scopes', async () => {
    const read = await callTool('insula_pat_read', 'call_operation', { operation: 'GET /tenant-only', asTenant: 'tenant-9' });
    expect(read.isError).toBe(false);
    expect(read.out.body).toEqual({ data: { tenantId: 'tenant-9', impersonatedBy: 'admin-1' } });
    // The impersonation token inherited `read` only: a tenant-side write is refused.
    const write = await callTool('insula_pat_read', 'call_operation', { operation: 'POST /tenant-only', asTenant: 'tenant-9', body: {} });
    expect(write.isError).toBe(true);
    expect(JSON.stringify(write.out.body)).toContain('INSUFFICIENT_SCOPE');
  });

  it('cannot reach the impersonation route — no tenant credential leaves the server', async () => {
    const { isError, out } = await callTool('insula_oat_good', 'call_operation', { operation: 'POST /admin/impersonate/:tenantId', pathParams: { tenantId: 'tenant-9' } });
    expect(isError).toBe(true);
    expect(String(out)).toMatch(/not available to agents/);
    expect(String(out)).not.toContain('a-one-hour-tenant-token');
  });

  it('reports a tenant it cannot act as, instead of running anything', async () => {
    const { isError, out } = await callTool('insula_oat_good', 'call_operation', { operation: 'GET /tenant-only', asTenant: 'tenant-gone' });
    expect(isError).toBe(true);
    expect(String(out)).toContain('Tenant not found');
  });

  it('keeps the CORS headers hooks set, although the reply is hijacked', async () => {
    const res = await rpc('insula_oat_good', 'tools/list');
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('a tenant-panel route without asTenant is refused by its own guard', async () => {
    const { isError, out } = await callTool('insula_oat_good', 'call_operation', { operation: 'GET /tenant-only' });
    expect(isError).toBe(true);
    expect(out.status).toBe(403);
  });
});

describe('a PAT on the plain REST API', () => {
  it('works for automation, with its scopes', async () => {
    const ok = await app.inject({ method: 'GET', url: '/api/v1/things', headers: { authorization: 'Bearer insula_pat_read' } });
    expect(ok.statusCode).toBe(200);
    const refused = await app.inject({
      method: 'POST', url: '/api/v1/things', headers: { authorization: 'Bearer insula_pat_read', 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'x' }),
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('an OAuth token is NOT a REST credential — it was issued for the MCP endpoint', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/things', headers: { authorization: 'Bearer insula_oat_good' } });
    expect(res.statusCode).toBe(401);
  });

  it('an unknown token is refused', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/things', headers: { authorization: 'Bearer insula_pat_nope' } });
    expect(res.statusCode).toBe(401);
  });

  it('cannot fetch a free-standing tenant token from the impersonation route', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/admin/impersonate/tenant-9', headers: { authorization: 'Bearer insula_pat_rw' } });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('a-one-hour-tenant-token');
  });
});

describe('the paths a proxy-protected admin host lets past OAuth2 Proxy', () => {
  it('are exactly the routes that authenticate themselves — no more, no fewer', () => {
    const selfAuthenticating = [...skipAuthUrls].filter((u) => u !== AGENT_TOKEN_CHECK_PATH).sort();
    expect(selfAuthenticating).toEqual([...SELF_AUTHENTICATING_PATHS].sort());
  });
});

describe('the edge check a proxy-protected admin host asks (ForwardAuth)', () => {
  const check = (authorization?: string) => app.inject({
    method: 'GET', url: '/api/v1/internal/agent-token-check', headers: authorization ? { authorization } : {},
  });

  it('passes a live PAT', async () => {
    expect((await check('Bearer insula_pat_read')).statusCode).toBe(204);
  });

  it('turns away a PAT-shaped header that is no token, an OAuth token, or nothing', async () => {
    expect((await check('Bearer insula_pat_made_up')).statusCode).toBe(401);
    expect((await check('Bearer insula_oat_good')).statusCode).toBe(401);
    expect((await check()).statusCode).toBe(401);
  });
});

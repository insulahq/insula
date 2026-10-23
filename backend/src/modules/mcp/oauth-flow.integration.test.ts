/**
 * The whole sign-in of an AI client, against a real Postgres and the real
 * routes: dynamic registration, authorize on a panel host, the consent API
 * with a panel session, the code exchange, refresh, an MCP tool call, and the
 * management routes that list and revoke what came of it.
 *
 * On the tenant host (tenant.example.test) it proves the rules that make a
 * tenant agent safe: only a tenant user signing in as themselves may approve
 * — not an admin, not an impersonation session — the operator's switch closes
 * the door, and the agent then acts as that user inside their tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { eq, inArray } from 'drizzle-orm';
import { getTestDb, isDbAvailable, runMigrations } from '../../test-helpers/db.js';
import { hostingPlans, mcpOauthClients, regions, tenants, users } from '../../db/schema.js';

const skipIntegration = !await isDbAvailable();
const ADMIN_HOST = 'admin.example.test';
const TENANT_HOST = 'tenant.example.test';
const REDIRECT = 'http://127.0.0.1:33418/callback';

describe.skipIf(skipIntegration)('AI-client sign-in, admin and tenant (integration)', () => {
  const uid = crypto.randomUUID().slice(0, 8);
  const adminId = crypto.randomUUID();
  const tenantUserId = crypto.randomUUID();
  const tenantId = crypto.randomUUID();
  const planId = crypto.randomUUID();
  const regionId = crypto.randomUUID();
  const registered: string[] = [];
  let app: FastifyInstance;
  let db: ReturnType<typeof getTestDb>;

  const session = (claims: Record<string, unknown>) => app.jwt.sign({ iat: Math.floor(Date.now() / 1000), ...claims } as never);
  let adminSession: string;
  let tenantSession: string;
  let impersonationSession: string;
  let colleagueSession: string;
  const colleagueId = crypto.randomUUID();

  beforeAll(async () => {
    await runMigrations();
    db = getTestDb();
    await db.insert(regions).values({ id: regionId, code: `${uid}-r`, name: `${uid}-region`, provider: 'test', status: 'active' });
    await db.insert(hostingPlans).values({
      id: planId, code: `${uid}-p`, name: `${uid}-plan`, cpuLimit: '1', memoryLimit: '1', storageLimit: '2', monthlyPriceUsd: '10.00',
    });
    await db.insert(tenants).values({
      id: tenantId, name: `Acme ${uid}`, primaryEmail: `${uid}@example.test`, kubernetesNamespace: `tenant-${uid}`, planId, regionId, status: 'active',
    });
    await db.insert(users).values([
      { id: adminId, email: `a-${uid}@test.local`, passwordHash: 'x', fullName: 'Admin', roleName: 'admin', panel: 'admin', status: 'active' },
      { id: tenantUserId, email: `t-${uid}@test.local`, passwordHash: 'x', fullName: 'Owner', roleName: 'tenant_admin', panel: 'tenant', status: 'active', tenantId },
      { id: colleagueId, email: `c-${uid}@test.local`, passwordHash: 'x', fullName: 'Colleague', roleName: 'tenant_user', panel: 'tenant', status: 'active', tenantId },
    ]);

    const { authenticate, requireTenantAccess } = await import('../../middleware/auth.js');
    const { enforceApiScope } = await import('../../shared/api-scope.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    const { collectOperations } = await import('./catalog.js');
    const { mcpEndpointRoutes } = await import('./server.js');
    const { mcpOauthRoutes } = await import('./oauth.js');
    const { mcpTokenRoutes } = await import('./token-routes.js');
    const { setTenantAgentsEnabled } = await import('./settings.js');
    await setTenantAgentsEnabled(db, true);

    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only-0123456789' });
    app.decorate('db', db as never);
    app.decorate('config', { PLATFORM_BASE_DOMAIN: 'example.test' } as never);
    app.setErrorHandler(errorHandler);
    const catalog = collectOperations(app);
    app.addHook('preHandler', async (request) => { enforceApiScope(request, 'handler'); });
    await app.register(async (api) => {
      api.addHook('onRequest', authenticate);
      api.get('/tenants/:tenantId/notes', { onRequest: [requireTenantAccess()] },
        async (request) => ({ data: { actor: request.user.sub, tenantId: request.user.tenantId } }));
    }, { prefix: '/api/v1' });
    await app.register(mcpEndpointRoutes(catalog));
    await app.register(mcpOauthRoutes);
    await app.register(mcpTokenRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminSession = session({ sub: adminId, role: 'admin', panel: 'admin', exp: Math.floor(Date.now() / 1000) + 600 });
    tenantSession = session({ sub: tenantUserId, role: 'tenant_admin', panel: 'tenant', tenantId, exp: Math.floor(Date.now() / 1000) + 600 });
    colleagueSession = session({ sub: colleagueId, role: 'tenant_user', panel: 'tenant', tenantId, exp: Math.floor(Date.now() / 1000) + 600 });
    impersonationSession = session({
      sub: tenantUserId, role: 'tenant_admin', panel: 'tenant', tenantId, impersonatedBy: adminId, exp: Math.floor(Date.now() / 1000) + 600,
    });
  });

  afterAll(async () => {
    const { setTenantAgentsEnabled } = await import('./settings.js');
    await setTenantAgentsEnabled(db, true);
    if (registered.length > 0) await db.delete(mcpOauthClients).where(inArray(mcpOauthClients.id, registered));
    await db.delete(users).where(inArray(users.id, [adminId, tenantUserId, colleagueId]));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    await db.delete(hostingPlans).where(eq(hostingPlans.id, planId));
    await db.delete(regions).where(eq(regions.id, regionId));
    await app?.close();
  });

  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  async function register(host: string): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/oauth/register', headers: { host, 'content-type': 'application/json' },
      payload: JSON.stringify({ client_name: 'Claude Code', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'] }),
    });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { client_id: string }).client_id;
    registered.push(id);
    return id;
  }

  /** authorize → the parked request id the consent page is opened with. */
  async function authorize(host: string, clientId: string, scope = 'read write'): Promise<string> {
    const qs = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge,
      code_challenge_method: 'S256', state: 'st', scope,
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/oauth/authorize?${qs}`, headers: { host } });
    expect(res.statusCode).toBe(302);
    const location = new URL(String(res.headers.location));
    expect(location.origin).toBe(`https://${host}`);
    expect(location.pathname).toBe('/oauth/consent');
    return location.searchParams.get('request') ?? '';
  }

  const consentGet = (requestId: string, token: string) => app.inject({
    method: 'GET', url: `/api/v1/oauth/requests/${requestId}`, headers: { authorization: `Bearer ${token}` },
  });
  const decide = (requestId: string, token: string, approve: boolean, scopes: string[] = ['read', 'write']) => app.inject({
    method: 'POST', url: `/api/v1/oauth/requests/${requestId}/decision`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ approve, scopes }),
  });
  const tokenCall = (host: string, form: Record<string, string>) => app.inject({
    method: 'POST', url: '/api/v1/oauth/token',
    headers: { host, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(form).toString(),
  });
  const mcp = (host: string, token: string, method: string, params?: unknown) => app.inject({
    method: 'POST', url: '/api/v1/mcp',
    headers: { host, authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });

  it('each host advertises itself as the authorization server and resource, with refresh', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/api/v1/mcp', headers: { host: TENANT_HOST } });
    expect(res.json()).toMatchObject({ resource: `https://${TENANT_HOST}/api/v1/mcp`, authorization_servers: [`https://${TENANT_HOST}`] });
    const as = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server', headers: { host: ADMIN_HOST } });
    expect(as.json()).toMatchObject({ issuer: `https://${ADMIN_HOST}`, grant_types_supported: ['authorization_code', 'refresh_token'] });
  });

  it('a tenant request can be approved only by a tenant user signing in as themselves', async () => {
    const clientId = await register(TENANT_HOST);
    const requestId = await authorize(TENANT_HOST, clientId);
    expect((await consentGet(requestId, adminSession)).json().error.code).toBe('AGENT_ACCESS_NOT_ALLOWED');
    const impersonated = await decide(requestId, impersonationSession, true);
    expect(impersonated.statusCode).toBe(403);
    expect(impersonated.json().error.message).toMatch(/impersonation session cannot connect/);
    const ok = await consentGet(requestId, tenantSession);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toMatchObject({ audience: 'tenant', clientName: 'Claude Code', requestedScopes: ['read', 'write'] });
  });

  it('"nobody approved this client" is per user — its author approving it silences nobody else', async () => {
    const clientId = await register(TENANT_HOST);
    const first = await authorize(TENANT_HOST, clientId, 'read');
    expect((await consentGet(first, tenantSession)).json().data.clientApprovedBefore).toBe(false);
    const decision = await decide(first, tenantSession, true, ['read']);
    const code = new URL(decision.json().data.redirectTo).searchParams.get('code') ?? '';
    await tokenCall(TENANT_HOST, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
    const again = await authorize(TENANT_HOST, clientId, 'read');
    expect((await consentGet(again, tenantSession)).json().data.clientApprovedBefore).toBe(true);
    expect((await consentGet(again, colleagueSession)).json().data.clientApprovedBefore).toBe(false);
  });

  it('an admin request cannot be approved from a tenant session', async () => {
    const clientId = await register(ADMIN_HOST);
    const requestId = await authorize(ADMIN_HOST, clientId);
    expect((await decide(requestId, tenantSession, true)).statusCode).toBe(403);
    expect((await consentGet(requestId, adminSession)).json().data.audience).toBe('admin');
  });

  it('end to end on the tenant host: approve, exchange, call as the tenant user, refresh, list, revoke', async () => {
    const clientId = await register(TENANT_HOST);
    const requestId = await authorize(TENANT_HOST, clientId);
    const decision = await decide(requestId, tenantSession, true, ['read']);
    const code = new URL(decision.json().data.redirectTo).searchParams.get('code') ?? '';

    const exchanged = await tokenCall(TENANT_HOST, {
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier,
    });
    expect(exchanged.statusCode).toBe(200);
    const t1 = exchanged.json() as { access_token: string; refresh_token: string; expires_in: number; scope: string };
    expect(t1).toMatchObject({ scope: 'read' });
    expect(t1.expires_in).toBeLessThanOrEqual(3600);
    expect(t1.refresh_token).toMatch(/^insula_ort_/);

    // The agent acts as the tenant user, in its tenant, and only on the tenant host.
    const call = await mcp(TENANT_HOST, t1.access_token, 'tools/call', { name: 'call_operation', arguments: { operation: 'GET /tenants/:tenantId/notes' } });
    const text = (call.json() as { result: { content: Array<{ text: string }> } }).result.content[0].text;
    expect(JSON.parse(text).body.data).toEqual({ actor: tenantUserId, tenantId });
    expect((await mcp(ADMIN_HOST, t1.access_token, 'tools/list')).statusCode).toBe(401);

    const refreshed = await tokenCall(TENANT_HOST, { grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: clientId });
    expect(refreshed.statusCode).toBe(200);
    const t2 = refreshed.json() as { access_token: string; refresh_token: string };
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect((await mcp(TENANT_HOST, t2.access_token, 'tools/list')).statusCode).toBe(200);

    // The tenant panel lists it; revoking there ends it for the agent.
    const listed = await app.inject({ method: 'GET', url: `/api/v1/tenants/${tenantId}/mcp-agents`, headers: { authorization: `Bearer ${tenantSession}` } });
    const agents = listed.json().data as { view: string; canConnect: boolean; connections: Array<{ id: string; clientName: string }> };
    expect(agents).toMatchObject({ view: 'tenant', canConnect: true });
    const mine = agents.connections.find((c) => c.clientName === 'Claude Code');
    expect(mine).toBeDefined();
    const revoked = await app.inject({
      method: 'DELETE', url: `/api/v1/tenants/${tenantId}/mcp-agents/${mine?.id}`, headers: { authorization: `Bearer ${tenantSession}` },
    });
    expect(revoked.statusCode).toBe(200);
    const { clearTokenCache } = await import('./tokens.js');
    clearTokenCache();
    expect((await mcp(TENANT_HOST, t2.access_token, 'tools/list')).statusCode).toBe(401);
    expect((await tokenCall(TENANT_HOST, { grant_type: 'refresh_token', refresh_token: t2.refresh_token, client_id: clientId })).statusCode).toBe(400);
  });

  it('agent-management routes are closed to the agents themselves', async () => {
    const clientId = await register(ADMIN_HOST);
    const requestId = await authorize(ADMIN_HOST, clientId, 'read');
    const decision = await decide(requestId, adminSession, true, ['read']);
    const code = new URL(decision.json().data.redirectTo).searchParams.get('code') ?? '';
    const t = (await tokenCall(ADMIN_HOST, {
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier,
    })).json() as { access_token: string };
    const call = await mcp(ADMIN_HOST, t.access_token, 'tools/call', { name: 'call_operation', arguments: { operation: 'GET /admin/mcp/connections' } });
    expect((call.json() as { result: { content: Array<{ text: string }> } }).result.content[0].text).toMatch(/not available to agents/);
  });

  it('the operator switch: off refuses tenant approvals and disconnects tenant agents', async () => {
    const clientId = await register(TENANT_HOST);
    const requestId = await authorize(TENANT_HOST, clientId);
    const off = await app.inject({
      method: 'PATCH', url: '/api/v1/admin/mcp/settings',
      headers: { authorization: `Bearer ${adminSession}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ tenantAgentsEnabled: false }),
    });
    expect(off.statusCode).toBe(200);
    const refused = await consentGet(requestId, tenantSession);
    expect(refused.json().error.code).toBe('TENANT_AGENTS_DISABLED');
    const listed = await app.inject({ method: 'GET', url: `/api/v1/tenants/${tenantId}/mcp-agents`, headers: { authorization: `Bearer ${tenantSession}` } });
    expect(listed.json().data).toMatchObject({ enabled: false, canConnect: false, connections: [] });
    const platform = await app.inject({ method: 'GET', url: '/api/v1/admin/mcp/connections', headers: { authorization: `Bearer ${adminSession}` } });
    expect(platform.json().data.tenantAgentsEnabled).toBe(false);
    await app.inject({
      method: 'PATCH', url: '/api/v1/admin/mcp/settings',
      headers: { authorization: `Bearer ${adminSession}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ tenantAgentsEnabled: true }),
    });
  });
});

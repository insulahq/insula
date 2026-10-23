/**
 * Agent connections against a real Postgres: what an approval becomes, how
 * long it lasts, and everything that ends it. A connection's 1-hour access
 * token is renewed with a refresh token that is replaced on every use; the
 * whole connection ends 8 hours after approval, on revoke, when a spent
 * refresh token is replayed, and — for a tenant agent — when its user leaves
 * the tenant or the operator switches tenant agents off.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { eq, inArray, like } from 'drizzle-orm';
import { getTestDb, isDbAvailable, runMigrations } from '../../test-helpers/db.js';
import { hostingPlans, mcpConnections, mcpOauthClients, mcpTokens, platformSettings, regions, tenants, users } from '../../db/schema.js';
import {
  clearTokenCache, createConnection, listConnections, reapExpired, refreshConnection, resolveToken,
  revokeByClientToken, revokeConnection, revokeTenantConnections,
} from './tokens.js';
import { TENANT_AGENTS_SETTING_KEY, clearAgentSettingsCache, setTenantAgentsEnabled, tenantAgentsEnabled } from './settings.js';

const skipIntegration = !await isDbAvailable();
const HOUR = 3_600_000;
const ADMIN_MCP = 'https://admin.example.test/api/v1/mcp';
const TENANT_MCP = 'https://tenant.example.test/api/v1/mcp';

describe.skipIf(skipIntegration)('MCP connections (integration)', () => {
  const uid = crypto.randomUUID().slice(0, 8);
  const adminId = crypto.randomUUID();
  const tenantAdminId = crypto.randomUUID();
  const tenantUserId = crypto.randomUUID();
  const otherTenantUserId = crypto.randomUUID();
  const tenantId = crypto.randomUUID();
  const otherTenantId = crypto.randomUUID();
  const planId = crypto.randomUUID();
  const regionId = crypto.randomUUID();
  const clientId = `it_conn_${uid}`;
  let db: ReturnType<typeof getTestDb>;

  const admin = (over: Partial<Parameters<typeof createConnection>[1]> = {}) => createConnection(db, {
    userId: adminId, tenantId: null, clientId, clientName: 'Claude', audience: 'admin', scopes: ['read', 'write'], resource: ADMIN_MCP, ...over,
  });
  const tenant = (userId: string, tid: string = tenantId) => createConnection(db, {
    userId, tenantId: tid, clientId, clientName: 'Cursor', audience: 'tenant', scopes: ['read'], resource: TENANT_MCP,
  });

  beforeAll(async () => {
    await runMigrations();
    db = getTestDb();
    await db.insert(regions).values({ id: regionId, code: `${uid}-r`, name: `${uid}-region`, provider: 'test', status: 'active' });
    await db.insert(hostingPlans).values({
      id: planId, code: `${uid}-p`, name: `${uid}-plan`, cpuLimit: '1', memoryLimit: '1', storageLimit: '2', monthlyPriceUsd: '10.00',
    });
    await db.insert(tenants).values([
      { id: tenantId, name: `Acme ${uid}`, primaryEmail: `${uid}@example.test`, kubernetesNamespace: `tenant-${uid}`, planId, regionId, status: 'active' },
      { id: otherTenantId, name: `Other ${uid}`, primaryEmail: `o-${uid}@example.test`, kubernetesNamespace: `tenant-o-${uid}`, planId, regionId, status: 'active' },
    ]);
    await db.insert(users).values([
      { id: adminId, email: `a-${uid}@test.local`, passwordHash: 'x', fullName: 'Admin', roleName: 'admin', panel: 'admin', status: 'active' },
      { id: tenantAdminId, email: `ta-${uid}@test.local`, passwordHash: 'x', fullName: 'Owner', roleName: 'tenant_admin', panel: 'tenant', status: 'active', tenantId },
      { id: tenantUserId, email: `tu-${uid}@test.local`, passwordHash: 'x', fullName: 'Staff', roleName: 'tenant_user', panel: 'tenant', status: 'active', tenantId },
      { id: otherTenantUserId, email: `o-${uid}@test.local`, passwordHash: 'x', fullName: 'Other', roleName: 'tenant_admin', panel: 'tenant', status: 'active', tenantId: otherTenantId },
    ]);
    await db.insert(mcpOauthClients).values({ id: clientId, name: 'Claude', redirectUris: ['http://127.0.0.1/cb'], lastUsedAt: new Date() });
  });

  beforeEach(async () => {
    clearTokenCache();
    await setTenantAgentsEnabled(db, true);
  });

  afterAll(async () => {
    await setTenantAgentsEnabled(db, true);
    await db.delete(mcpOauthClients).where(like(mcpOauthClients.id, `it_conn_${uid}%`)); // cascades connections + tokens
    await db.delete(users).where(inArray(users.id, [adminId, tenantAdminId, tenantUserId, otherTenantUserId]));
    await db.delete(tenants).where(inArray(tenants.id, [tenantId, otherTenantId]));
    await db.delete(hostingPlans).where(eq(hostingPlans.id, planId));
    await db.delete(regions).where(eq(regions.id, regionId));
  });

  it('an approval becomes a connection whose access token lasts an hour and the connection 8', async () => {
    const before = Date.now();
    const c = await admin();
    expect(c.access.expiresIn).toBeGreaterThan(3590);
    expect(c.access.expiresIn).toBeLessThanOrEqual(3600);
    const [row] = await db.select().from(mcpConnections).where(eq(mcpConnections.id, c.connectionId));
    expect(row.expiresAt.getTime() - before).toBeGreaterThanOrEqual(8 * HOUR - 5_000);
    expect(row.expiresAt.getTime() - before).toBeLessThanOrEqual(8 * HOUR + 5_000);
    expect(row.refreshTokenHash).not.toContain(c.refreshToken);
    expect(await resolveToken(db, c.access.token)).toMatchObject({
      kind: 'oauth', audience: 'admin', userId: adminId, connectionId: c.connectionId, tenantId: null, resource: ADMIN_MCP,
    });
  });

  it('refresh renews the access token and REPLACES the refresh token', async () => {
    const c = await admin();
    const r = await refreshConnection(db, c.refreshToken, clientId);
    if (!r.ok) throw new Error(r.reason);
    expect(r.issued.refreshToken).not.toBe(c.refreshToken);
    expect(r.issued.connectionId).toBe(c.connectionId);
    expect(await resolveToken(db, r.issued.access.token)).toMatchObject({ connectionId: c.connectionId, scopes: ['read', 'write'] });
    // The new refresh token works in turn.
    const again = await refreshConnection(db, r.issued.refreshToken, clientId);
    expect(again.ok).toBe(true);
  });

  it('a spent refresh token, presented again, ends the whole connection', async () => {
    const c = await admin();
    const r = await refreshConnection(db, c.refreshToken, clientId);
    if (!r.ok) throw new Error(r.reason);
    const replay = await refreshConnection(db, c.refreshToken, clientId);
    expect(replay).toMatchObject({ ok: false });
    clearTokenCache();
    expect(await resolveToken(db, r.issued.access.token)).toBeNull();
    expect(await refreshConnection(db, r.issued.refreshToken, clientId)).toMatchObject({ ok: false });
  });

  it('refuses a refresh token presented by another client', async () => {
    const c = await admin();
    expect(await refreshConnection(db, c.refreshToken, 'mcp_someone_else')).toMatchObject({ ok: false });
    // …without spending it.
    expect((await refreshConnection(db, c.refreshToken, clientId)).ok).toBe(true);
  });

  it('ends 8 hours after approval: no access token outlives it and refresh stops', async () => {
    const c = await admin();
    const eightHours = Date.now() + 8 * HOUR + 60_000;
    expect(await resolveToken(db, c.access.token, eightHours)).toBeNull();
    expect(await refreshConnection(db, c.refreshToken, clientId, new Date(eightHours))).toMatchObject({ ok: false });
    // An access token issued 30 minutes before the end lasts 30 minutes, not an hour.
    const late = await refreshConnection(db, c.refreshToken, clientId, new Date(Date.now() + 7.5 * HOUR));
    if (!late.ok) throw new Error(late.reason);
    expect(late.issued.access.expiresIn).toBeLessThanOrEqual(30 * 60 + 5);
  });

  it('revoking the connection stops its tokens; the client can revoke it with either token', async () => {
    const c = await admin();
    expect(await revokeConnection(db, c.connectionId, { userId: adminId })).toBe(true);
    expect(await resolveToken(db, c.access.token)).toBeNull();
    expect(await refreshConnection(db, c.refreshToken, clientId)).toMatchObject({ ok: false });

    const byRefresh = await admin();
    await revokeByClientToken(db, byRefresh.refreshToken);
    clearTokenCache();
    expect(await resolveToken(db, byRefresh.access.token)).toBeNull();

    const byAccess = await admin();
    await revokeByClientToken(db, byAccess.access.token);
    expect(await refreshConnection(db, byAccess.refreshToken, clientId)).toMatchObject({ ok: false });
  });

  it('a tenant agent acts in its user\'s tenant — until the user leaves it', async () => {
    const c = await tenant(tenantUserId);
    expect(await resolveToken(db, c.access.token)).toMatchObject({
      audience: 'tenant', tenantId, userId: tenantUserId, role: 'tenant_user', resource: TENANT_MCP,
    });
    await db.update(users).set({ tenantId: otherTenantId }).where(eq(users.id, tenantUserId));
    clearTokenCache();
    expect(await resolveToken(db, c.access.token)).toBeNull();
    await db.update(users).set({ tenantId }).where(eq(users.id, tenantUserId));
  });

  it('switching tenant agents off stops every tenant token at once; admin agents carry on', async () => {
    const t = await tenant(tenantAdminId);
    const a = await admin();
    await setTenantAgentsEnabled(db, false);
    clearTokenCache();
    expect(await resolveToken(db, t.access.token)).toBeNull();
    expect(await resolveToken(db, a.access.token)).not.toBeNull();
    // The settings route also disconnects them, so switching back on does not revive them.
    expect(await revokeTenantConnections(db)).toBeGreaterThanOrEqual(1);
    await setTenantAgentsEnabled(db, true);
    clearTokenCache();
    expect(await resolveToken(db, t.access.token)).toBeNull();
    expect(await resolveToken(db, a.access.token)).not.toBeNull();
  });

  it('tenant agents are OFF on an installation that never switched them on', async () => {
    await db.delete(platformSettings).where(eq(platformSettings.key, TENANT_AGENTS_SETTING_KEY));
    clearAgentSettingsCache();
    expect(await tenantAgentsEnabled(db)).toBe(false);
    const t = await tenant(tenantAdminId);
    expect(await resolveToken(db, t.access.token)).toBeNull();
  });

  it('a cached token never outlives the connection it belongs to', async () => {
    const c = await admin();
    const [row] = await db.select().from(mcpConnections).where(eq(mcpConnections.id, c.connectionId));
    const end = row.expiresAt.getTime();
    // Renewed 20 s before the end: the new access token ends with the connection.
    const late = await refreshConnection(db, c.refreshToken, clientId, new Date(end - 20_000));
    if (!late.ok) throw new Error(late.reason);
    expect(await resolveToken(db, late.issued.access.token, end - 10_000)).not.toBeNull(); // cached here
    // 15 s later — inside the cache window, past the end.
    expect(await resolveToken(db, late.issued.access.token, end + 5_000)).toBeNull();
  });

  it('lists what each viewer may see: own, the tenant\'s, or everything', async () => {
    const mine = await tenant(tenantUserId);
    const owners = await tenant(tenantAdminId);
    const elsewhere = await tenant(otherTenantUserId, otherTenantId);
    const ids = (list: Awaited<ReturnType<typeof listConnections>>) => list.map((c) => c.id);

    expect(ids(await listConnections(db, { userId: tenantUserId }))).toEqual([mine.connectionId]);
    const tenantWide = ids(await listConnections(db, { tenantId }));
    expect(tenantWide).toEqual(expect.arrayContaining([mine.connectionId, owners.connectionId]));
    expect(tenantWide).not.toContain(elsewhere.connectionId);
    const all = await listConnections(db, { all: true });
    expect(ids(all)).toEqual(expect.arrayContaining([mine.connectionId, elsewhere.connectionId]));
    const shown = all.find((c) => c.id === elsewhere.connectionId);
    expect(shown).toMatchObject({ audience: 'tenant', clientName: 'Cursor', tenant: { id: otherTenantId }, user: { id: otherTenantUserId } });

    // A tenant admin cannot reach into another tenant; a user cannot revoke a colleague's.
    expect(await revokeConnection(db, elsewhere.connectionId, { tenantId })).toBe(false);
    expect(await revokeConnection(db, owners.connectionId, { userId: tenantUserId })).toBe(false);
    expect(await revokeConnection(db, mine.connectionId, { tenantId })).toBe(true);
    expect(ids(await listConnections(db, { tenantId }))).not.toContain(mine.connectionId);
  });

  it('the reaper removes connections a day after they end, taking their tokens', async () => {
    const c = await admin();
    const [token] = await db.select({ id: mcpTokens.id }).from(mcpTokens).where(eq(mcpTokens.connectionId, c.connectionId));
    expect(token).toBeDefined();
    await reapExpired(db, new Date(Date.now() + 8 * HOUR + 2 * HOUR));
    expect(await db.select().from(mcpConnections).where(eq(mcpConnections.id, c.connectionId))).toHaveLength(1);
    await reapExpired(db, new Date(Date.now() + 8 * HOUR + 25 * HOUR));
    expect(await db.select().from(mcpConnections).where(eq(mcpConnections.id, c.connectionId))).toHaveLength(0);
    expect(await db.select().from(mcpTokens).where(eq(mcpTokens.id, token.id))).toHaveLength(0);
  });
});

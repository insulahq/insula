/**
 * The token store against a real Postgres: who a token resolves to (and when
 * it stops resolving), and what the reaper is allowed to delete. The OAuth
 * tables cascade from their client, so a reaper that deleted a client with a
 * live token would silently sign an agent out — these rows prove it cannot.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { eq, inArray, like } from 'drizzle-orm';
import { getTestDb, isDbAvailable, runMigrations } from '../../test-helpers/db.js';
import { mcpOauthClients, mcpOauthRequests, mcpTokens, users } from '../../db/schema.js';
import {
  clearTokenCache, createPat, evictUnapprovedClient, hashSecret, reapExpired, resolveToken, revokeToken,
} from './tokens.js';

const skipIntegration = !await isDbAvailable();
const DAY = 86_400_000;

describe.skipIf(skipIntegration)('MCP token store (integration)', () => {
  const adminId = crypto.randomUUID();
  const superId = crypto.randomUUID();
  let db: ReturnType<typeof getTestDb>;

  beforeAll(async () => {
    await runMigrations();
    db = getTestDb();
    await db.insert(users).values([
      { id: adminId, email: `${adminId}@test.local`, passwordHash: 'unused', fullName: 'Admin', roleName: 'admin', panel: 'admin', status: 'active' },
      { id: superId, email: `${superId}@test.local`, passwordHash: 'unused', fullName: 'Super', roleName: 'super_admin', panel: 'admin', status: 'active' },
    ]);
  });

  beforeEach(() => { clearTokenCache(); });

  afterAll(async () => {
    await db.delete(mcpOauthClients).where(like(mcpOauthClients.id, 'it_%'));
    await db.delete(users).where(inArray(users.id, [adminId, superId])); // cascades tokens
  });

  it('stores only the hash, and resolves a PAT to its owner with its scopes', async () => {
    const { token, row } = await createPat(db, { userId: adminId, name: 'ci', scopes: ['read', 'write'], expiresInDays: 7 });
    const [stored] = await db.select().from(mcpTokens).where(eq(mcpTokens.id, row.id));
    expect(stored.tokenHash).toBe(hashSecret(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    const p = await resolveToken(db, token);
    expect(p).toMatchObject({ tokenId: row.id, kind: 'pat', userId: adminId, role: 'admin', scopes: ['read', 'write'] });
  });

  it('stops resolving once revoked, expired, or its owner loses the admin role or is disabled', async () => {
    const revoked = await createPat(db, { userId: adminId, name: 'r', scopes: ['read'], expiresInDays: null });
    expect(await revokeToken(db, adminId, revoked.row.id)).toBe(true);
    expect(await resolveToken(db, revoked.token)).toBeNull();

    const expiring = await createPat(db, { userId: adminId, name: 'e', scopes: ['read'], expiresInDays: 7 });
    expect(await resolveToken(db, expiring.token, Date.now() + 8 * DAY)).toBeNull();

    const role = await createPat(db, { userId: adminId, name: 'role', scopes: ['read'], expiresInDays: null });
    expect(await resolveToken(db, role.token)).not.toBeNull();
    await db.update(users).set({ roleName: 'support' }).where(eq(users.id, adminId));
    clearTokenCache();
    expect(await resolveToken(db, role.token)).toBeNull();
    await db.update(users).set({ roleName: 'admin', status: 'disabled' }).where(eq(users.id, adminId));
    clearTokenCache();
    expect(await resolveToken(db, role.token)).toBeNull();
    await db.update(users).set({ status: 'active' }).where(eq(users.id, adminId));
  });

  it('never resolves for a super_admin, even if a row exists', async () => {
    const t = await createPat(db, { userId: superId, name: 'sa', scopes: ['read'], expiresInDays: null });
    expect(await resolveToken(db, t.token)).toBeNull();
  });

  it('a user cannot revoke someone else\'s token', async () => {
    const t = await createPat(db, { userId: adminId, name: 'mine', scopes: ['read'], expiresInDays: null });
    expect(await revokeToken(db, superId, t.row.id)).toBe(false);
    expect(await resolveToken(db, t.token)).not.toBeNull();
  });

  it('reaps only unreferenced stale clients, and at the cap evicts the oldest never-approved one', async () => {
    const ago = (ms: number) => new Date(Date.now() - ms);
    const rows: Array<[string, Date, Date | null]> = [
      ['it_unapproved_old', ago(2 * DAY), null],                // reaped
      ['it_unapproved_new', ago(60_000), null],                 // kept: young
      ['it_idle_old', ago(60 * DAY), ago(31 * DAY)],            // reaped
      ['it_idle_recent', ago(60 * DAY), ago(5 * DAY)],          // kept: used recently
      ['it_old_with_token', ago(60 * DAY), ago(40 * DAY)],      // kept: live token
      ['it_old_with_request', ago(3 * DAY), null],              // kept: pending request
      ['it_answered', ago(4 * DAY), null],                      // kept: approved, code not yet redeemed
    ];
    await db.insert(mcpOauthClients).values(rows.map(([id, createdAt, lastUsedAt]) => ({
      id, name: 'x', redirectUris: ['http://127.0.0.1/cb'], createdAt, lastUsedAt,
    })));
    await db.insert(mcpTokens).values({
      id: crypto.randomUUID(), kind: 'oauth', tokenHash: hashSecret(crypto.randomUUID()), prefix: 'insula_oat_',
      userId: adminId, clientId: 'it_old_with_token', name: 'x', scopes: ['read'], expiresAt: new Date(Date.now() + 3_600_000),
    });
    await db.insert(mcpOauthRequests).values([
      {
        id: `it_req_${crypto.randomUUID()}`, clientId: 'it_old_with_request', redirectUri: 'http://127.0.0.1/cb',
        codeChallenge: 'c', resource: 'r', requestedScopes: ['read'], expiresAt: new Date(Date.now() + 600_000),
      },
      {
        id: `it_req_${crypto.randomUUID()}`, clientId: 'it_answered', redirectUri: 'http://127.0.0.1/cb',
        codeChallenge: 'c', resource: 'r', requestedScopes: ['read'], expiresAt: new Date(Date.now() + 600_000),
        userId: adminId, grantedScopes: ['read'], codeHash: hashSecret(crypto.randomUUID()),
      },
    ]);

    const left = async () => (await db.select({ id: mcpOauthClients.id }).from(mcpOauthClients)
      .where(like(mcpOauthClients.id, 'it_%'))).map((r) => r.id).sort();

    const res = await reapExpired(db);
    expect(res.clients).toBe(2);
    expect(await left()).toEqual(['it_answered', 'it_idle_recent', 'it_old_with_request', 'it_old_with_token', 'it_unapproved_new']);

    // The oldest never-approved client without a token goes, its unanswered
    // request with it — but not the OLDER one a person already approved.
    expect(await evictUnapprovedClient(db)).toBe(true);
    expect(await left()).toEqual(['it_answered', 'it_idle_recent', 'it_old_with_token', 'it_unapproved_new']);
  });
});

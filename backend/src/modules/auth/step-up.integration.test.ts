/**
 * Step-up against a real Postgres: it binds to the SESSION that made it, under
 * "Login as tenant" to the staff member's own credential, key material asks
 * again after 5 minutes, and API tokens pass. Then the temporary certificate
 * download links: refused once expired or outside the rules, and reaped.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant, seedDomain } from '../../test-helpers/fixtures.js';
import { authStepUps, certDownloadTokens, users } from '../../db/schema.js';
import { assertFreshStepUp, getStepUpStatus, recordStepUp, stepUpMaxAgeMs } from './step-up-service.js';
import { createToken, listTokens, reapExpiredTokens, verifyToken } from '../cert-download/token-service.js';
import { reapCertTokensOnce } from '../cert-download/token-reaper.js';

const dbAvailable = await isDbAvailable();

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
  return 'passed';
}

describe.skipIf(!dbAvailable)('step-up per session (integration)', () => {
  const db = () => getTestDb();
  const owner = crypto.randomUUID();
  const staff = crypto.randomUUID();
  const tenantUser = crypto.randomUUID();

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql.raw('TRUNCATE TABLE auth_step_ups, cert_download_tokens CASCADE'));
    for (const [id, panel, role] of [[owner, 'admin', 'admin'], [staff, 'admin', 'support'], [tenantUser, 'tenant', 'tenant_admin']] as const) {
      await db().insert(users).values({
        id, email: `${id}@example.test`, passwordHash: 'h', fullName: 'Test', roleName: role, panel, status: 'active',
      } as typeof users.$inferInsert);
    }
  });

  it('a step-up counts for the session that made it, not for another session of the same user', async () => {
    const a = { sub: owner, sid: 'family-a' };
    const b = { sub: owner, sid: 'family-b' };
    await recordStepUp(db(), a, 'password');
    expect(await refusal(assertFreshStepUp(db(), a, 'cert_download'))).toBe('passed');
    expect(await refusal(assertFreshStepUp(db(), b, 'cert_download'))).toBe('STEP_UP_REQUIRED');
  });

  it('signing in is not a step-up: users.last_step_up_at alone opens nothing', async () => {
    await db().update(users).set({ lastStepUpAt: new Date() }).where(eq(users.id, owner));
    expect(await refusal(assertFreshStepUp(db(), { sub: owner, sid: 'family-a' }, 'dkim_private_key'))).toBe('STEP_UP_REQUIRED');
  });

  it('key material asks again after 5 minutes; the node terminal keeps its 30', async () => {
    const a = { sub: owner, sid: 'family-a' };
    await recordStepUp(db(), a, 'password');
    await db().update(authStepUps).set({ steppedUpAt: sql`now() - interval '6 minutes'` }).where(eq(authStepUps.sessionId, 'family-a'));
    expect(await refusal(assertFreshStepUp(db(), a, 'dkim_private_key'))).toBe('STEP_UP_REQUIRED');
    expect((await getStepUpStatus(db(), a, stepUpMaxAgeMs('node_terminal'))).required).toBe(false);
    await db().update(authStepUps).set({ steppedUpAt: sql`now() - interval '31 minutes'` }).where(eq(authStepUps.sessionId, 'family-a'));
    expect((await getStepUpStatus(db(), a, stepUpMaxAgeMs('node_terminal'))).required).toBe(true);
  });

  it('under "Login as tenant" the staff member\'s own step-up opens it; the tenant user\'s would not', async () => {
    const imp = { sub: tenantUser, impersonatedBy: staff, sid: 'imp:t1' };
    expect(await refusal(assertFreshStepUp(db(), imp, 'cert_download'))).toBe('STEP_UP_REQUIRED');
    await recordStepUp(db(), imp, 'password');
    const [row] = await db().select().from(authStepUps).where(eq(authStepUps.sessionId, 'imp:t1'));
    expect(row.userId).toBe(staff);
    expect(await refusal(assertFreshStepUp(db(), imp, 'cert_download'))).toBe('passed');
    // A row for the same session but the TENANT user's credential does not count.
    await db().update(authStepUps).set({ userId: tenantUser }).where(eq(authStepUps.sessionId, 'imp:t1'));
    expect(await refusal(assertFreshStepUp(db(), imp, 'cert_download'))).toBe('STEP_UP_REQUIRED');
    // And the staff member's step-up under impersonation is not one for their own admin session.
    await recordStepUp(db(), imp, 'password');
    expect(await refusal(assertFreshStepUp(db(), { sub: staff, sid: 'staff-family' }, 'cert_download'))).toBe('STEP_UP_REQUIRED');
  });

  it('an API token passes with no step-up at all', async () => {
    expect(await refusal(assertFreshStepUp(db(), { sub: owner, apiToken: { tokenId: 'pat-1' } }, 'dkim_private_key'))).toBe('passed');
  });

  it('a new step-up prunes rows older than a day', async () => {
    await db().insert(authStepUps).values({ sessionId: 'old', userId: owner, method: 'password', steppedUpAt: new Date(Date.now() - 2 * 86_400_000) });
    await recordStepUp(db(), { sub: owner, sid: 'family-a' }, 'passkey');
    const ids = (await db().select({ id: authStepUps.sessionId }).from(authStepUps)).map((r) => r.id);
    expect(ids).toEqual(['family-a']);
  });
});

describe.skipIf(!dbAvailable)('temporary certificate download links (integration)', () => {
  const db = () => getTestDb();
  let tenantId = '';
  let domainId = '';

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql.raw('TRUNCATE TABLE cert_download_tokens CASCADE'));
    const regionId = (await seedRegion(db())).id;
    const planId = (await seedPlan(db())).id;
    tenantId = (await seedTenant(db(), regionId, planId)).id;
    domainId = (await seedDomain(db(), tenantId, { domainName: 'links.example.com' })).id;
  });

  it('mints with the chosen lifetime and works until it expires', async () => {
    const before = Date.now();
    const link = await createToken(db(), tenantId, domainId, { name: 'move', expiry: '15m' }, null);
    const lifetime = new Date(link.expiresAt).getTime() - before;
    expect(lifetime).toBeGreaterThan(14 * 60_000);
    expect(lifetime).toBeLessThanOrEqual(15 * 60_000 + 5_000);
    expect(await verifyToken(db(), link.token)).toMatchObject({ domainId });
    expect(await verifyToken(db(), link.token, new Date(Date.now() + 16 * 60_000))).toBeNull();
  });

  it('the reaper deletes expired links and links outside the rules, and keeps live ones', async () => {
    const live = await createToken(db(), tenantId, domainId, { name: 'live', expiry: '24h' }, null);
    const base = { tenantId, domainId, tokenHash: '', createdBy: null };
    const now = Date.now();
    await db().insert(certDownloadTokens).values([
      { ...base, id: crypto.randomUUID(), name: 'expired', tokenHash: 'h1', createdAt: new Date(now - 2 * 3600_000), expiresAt: new Date(now - 3600_000) },
      // Minted by old code mid-rollout: never expiring, and a year.
      { ...base, id: crypto.randomUUID(), name: 'never', tokenHash: 'h2', createdAt: new Date(now), expiresAt: null },
      { ...base, id: crypto.randomUUID(), name: 'year', tokenHash: 'h3', createdAt: new Date(now), expiresAt: new Date(now + 365 * 86_400_000) },
    ]);
    // Listed only while within the rules.
    expect((await listTokens(db(), tenantId, domainId)).map((t) => t.name).sort()).toEqual(['expired', 'live']);
    expect(await reapExpiredTokens(db())).toBe(3);
    const left = await db().select({ id: certDownloadTokens.id }).from(certDownloadTokens);
    expect(left.map((r) => r.id)).toEqual([live.id]);
  });

  it('the leased reaper runs the same delete', async () => {
    const now = Date.now();
    await db().insert(certDownloadTokens).values({
      id: crypto.randomUUID(), tenantId, domainId, name: 'expired', tokenHash: 'h1', createdBy: null,
      createdAt: new Date(now - 2 * 3600_000), expiresAt: new Date(now - 3600_000),
    });
    const logged: unknown[] = [];
    await reapCertTokensOnce(db(), { info: (o) => logged.push(o), warn: (o) => logged.push(o) });
    expect(await db().select().from(certDownloadTokens)).toHaveLength(0);
    expect(logged).toEqual([{ removed: 1 }]);
  });
});

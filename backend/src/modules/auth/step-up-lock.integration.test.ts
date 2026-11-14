/**
 * Wrong step-up passwords are limited per credential holder, not only per IP
 * (the route's rate limit runs before the token is read). Through the real
 * route and Postgres: under "Login as tenant", five wrong staff passwords,
 * then 429 even for the right one until the window passes; every failure is
 * audited with the impersonation; a right password gives the window back.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { and, eq, sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { auditLogs, users } from '../../db/schema.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { hashNewPassword } from './service.js';
import { STEP_UP_MAX_FAILED_PASSWORDS } from './step-up-service.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('step-up password lock (integration)', () => {
  const db = () => getTestDb();
  const staff = crypto.randomUUID();
  const tenantUser = crypto.randomUUID();
  let app: FastifyInstance;
  let imp = '';

  beforeAll(async () => {
    await runMigrations();
    process.env.PLATFORM_PASSKEY_RP_ID ??= 'example.test';
    process.env.PLATFORM_PASSKEY_ORIGINS ??= 'https://tenant.example.test';
    const { stepUpRoutes } = await import('./step-up-routes.js');
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    app.setErrorHandler(errorHandler);
    app.decorate('db', getTestDb());
    await app.register(stepUpRoutes, { prefix: '/api/v1' });
    await app.ready();
  });
  afterAll(async () => { await app.close(); await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql.raw('TRUNCATE TABLE auth_step_ups CASCADE'));
    await db().insert(users).values([
      { id: staff, email: `${staff}@example.test`, passwordHash: await hashNewPassword('staff-pass'), fullName: 'Staff', roleName: 'admin', panel: 'admin', status: 'active' },
      { id: tenantUser, email: `${tenantUser}@example.test`, passwordHash: await hashNewPassword('tenant-pass'), fullName: 'Tenant', roleName: 'tenant_admin', panel: 'tenant', status: 'active' },
    ] as Array<typeof users.$inferInsert>);
    imp = app.jwt.sign({
      sub: tenantUser, role: 'tenant_admin', panel: 'tenant', impersonatedBy: staff, sid: 'imp:lock', iat: Math.floor(Date.now() / 1000),
    });
  });

  const attempt = (password: string) => app.inject({
    method: 'POST', url: '/api/v1/me/step-up/password', headers: { authorization: `Bearer ${imp}` }, payload: { password },
  });

  it('locks the holder after five wrong passwords, audits each with the impersonation, and lets the right one in after the window', async () => {
    for (let i = 0; i < STEP_UP_MAX_FAILED_PASSWORDS; i++) {
      expect((await attempt('wrong')).statusCode).toBe(401);
    }
    const locked = await attempt('staff-pass');
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('STEP_UP_LOCKED');
    expect(locked.json().error.details.retry_after).toBeGreaterThan(0);

    const failures = await db().select({ changes: auditLogs.changes, actorId: auditLogs.actorId })
      .from(auditLogs).where(eq(auditLogs.actionType, 'step_up.password.failed'));
    expect(failures).toHaveLength(STEP_UP_MAX_FAILED_PASSWORDS);
    for (const f of failures) {
      expect(f.actorId).toBe(staff);
      expect(f.changes).toMatchObject({ impersonatedBy: staff, actingAs: tenantUser });
    }
    // The refusal while locked is its own event: the password was not checked.
    const lockedRows = await db().select({ changes: auditLogs.changes, status: auditLogs.httpStatus })
      .from(auditLogs).where(eq(auditLogs.actionType, 'step_up.password.locked'));
    expect(lockedRows).toHaveLength(1);
    expect(lockedRows[0].status).toBe(429);
    expect(lockedRows[0].changes).toMatchObject({ reason: 'STEP_UP_LOCKED', impersonatedBy: staff, retryAfter: expect.any(Number) });

    // The window passes: the right password goes through and gives the attempts back.
    await db().update(users).set({ stepUpFailedWindowStartedAt: sql`now() - interval '16 minutes'` }).where(eq(users.id, staff));
    expect((await attempt('staff-pass')).statusCode).toBe(200);
    const [row] = await db().select({ n: users.stepUpFailedAttempts }).from(users).where(eq(users.id, staff));
    expect(row.n).toBe(0);
    // The tenant user's own allowance was never touched.
    const [tenant] = await db().select({ n: users.stepUpFailedAttempts }).from(users).where(and(eq(users.id, tenantUser)));
    expect(tenant.n).toBe(0);
  });

  // A guesser's attempts must not be refreshed by the owner stepping up
  // elsewhere: a right password gives back only its own attempt.
  it('the owner\'s success does not give the guesser\'s attempts back', async () => {
    for (let i = 0; i < 3; i++) expect((await attempt('wrong')).statusCode).toBe(401);
    expect((await attempt('staff-pass')).statusCode).toBe(200);
    const [row] = await db().select({ n: users.stepUpFailedAttempts }).from(users).where(eq(users.id, staff));
    expect(row.n).toBe(3);
    expect((await attempt('wrong')).statusCode).toBe(401);
    expect((await attempt('wrong')).statusCode).toBe(401);
    expect((await attempt('wrong')).statusCode).toBe(429);
  });

  it('parallel guesses cannot get past the allowance', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => attempt('wrong')));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401)).toHaveLength(STEP_UP_MAX_FAILED_PASSWORDS);
    expect(codes.filter((c) => c === 429)).toHaveLength(12 - STEP_UP_MAX_FAILED_PASSWORDS);
  });
});

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError, invalidToken } from '../../shared/errors.js';
import { auditLogs, users } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  loadPasskeyConfig,
  beginRegistration,
  completeRegistration,
  beginAuthentication,
  completeAuthentication,
  listPasskeys,
  deletePasskey,
  setPasskeyMode,
  type PasskeyMode,
  type PasskeyPanel,
} from './passkey-service.js';
import { issueSession } from './session.js';
import { isLocalAuthDisabled } from '../oidc/service.js';
import type { Database } from '../../db/index.js';

/**
 * Resolve the panel for a request:
 *   • Unauthenticated endpoints: from body.panel (matches /auth/login).
 *   • Authenticated endpoints: from the JWT panel claim.
 */
function panelFromBody(request: FastifyRequest): PasskeyPanel {
  const body = (request.body ?? {}) as { panel?: unknown };
  return body.panel === 'tenant' ? 'tenant' : 'admin';
}

async function recordAudit(
  db: Database,
  actorId: string,
  actionType: string,
  resourceId: string | null,
  request: FastifyRequest,
  changes?: Record<string, unknown>,
) {
  try {
    await db.insert(auditLogs).values({
      id: randomUUID(),
      tenantId: null,
      actionType,
      resourceType: 'passkey',
      resourceId: resourceId ?? actorId,
      actorId,
      actorType: 'user',
      httpMethod: request.method,
      httpPath: request.url.slice(0, 500),
      httpStatus: 200,
      changes: changes ?? null,
      ipAddress: request.ip,
    });
  } catch (err) {
    request.log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      `[passkey-routes] audit log insert failed for ${actionType}`,
    );
  }
}

export async function passkeyRoutes(app: FastifyInstance) {
  const config = loadPasskeyConfig();

  /**
   * Begin registration. Authenticated — caller must be the user
   * adding a passkey to their own account. CSRF defense: requires
   * Authorization: Bearer header (cookie auth alone is rejected) so
   * a cross-site form submission can't enroll an attacker's passkey.
   */
  app.post('/auth/passkey/registration/options', async (request, reply) => {
    await assertBearerAuth(request);
    const payload = request.user as { sub: string; panel: 'admin' | 'tenant' };
    const options = await beginRegistration(app.db, config, payload.sub, payload.panel);
    return reply.send({ data: options });
  });

  /**
   * Complete registration. Verifies the attestation and persists the
   * credential. nickname is required so the UI can show "iPhone",
   * "YubiKey 5C", etc. on the manage page.
   */
  app.post('/auth/passkey/registration/verify', async (request, reply) => {
    await assertBearerAuth(request);
    const payload = request.user as { sub: string; panel: 'admin' | 'tenant' };
    const body = (request.body ?? {}) as { response?: unknown; nickname?: unknown };
    if (!body.response || typeof body.nickname !== 'string' || body.nickname.length === 0) {
      throw new ApiError('VALIDATION_ERROR', 'response and nickname are required', 400);
    }
    const result = await completeRegistration(app.db, config, {
      userId: payload.sub,
      panel: payload.panel,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: body.response as any,
      nickname: body.nickname,
    });
    await recordAudit(app.db, payload.sub, 'passkey_registered', result.id, request, {
      nickname: result.nickname,
    });
    return reply.send({ data: result });
  });

  /**
   * Begin passkey sign-in (userless / discoverable credentials: the browser
   * offers the passkeys it holds for this RP). A passkey signs in on its own
   * — there is no password-plus-passkey flow; the second factor for a
   * password is TOTP (totp-routes.ts).
   */
  app.post('/auth/passkey/login/options', {
    config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const panel = panelFromBody(request);
    if (await isLocalAuthDisabled(app.db, panel)) {
      throw new ApiError('LOCAL_AUTH_DISABLED', 'Local authentication is disabled for this panel', 403);
    }
    const options = await beginAuthentication(app.db, config, panel, null);
    return reply.send({ data: options });
  });

  /** Complete passkey sign-in. On success, issues the same session as /auth/login. */
  app.post('/auth/passkey/login/verify', {
    config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const panel = panelFromBody(request);
    if (await isLocalAuthDisabled(app.db, panel)) {
      throw new ApiError('LOCAL_AUTH_DISABLED', 'Local authentication is disabled for this panel', 403);
    }
    const body = (request.body ?? {}) as { response?: unknown };
    if (!body.response) {
      throw new ApiError('VALIDATION_ERROR', 'response is required', 400);
    }

    const result = await completeAuthentication(app.db, config, {
      panel,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: body.response as any,
    });

    const user = result.user;
    const session = await issueSession(app, request, reply, {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.roleName,
      panel: user.panel,
      tenantId: user.tenantId,
    });

    await recordAudit(
      app.db,
      user.id,
      'passkey_login_userless',
      result.passkeyId,
      request,
    );

    return reply.send({ data: session });
  });

  /** List the caller's passkeys + current mode. */
  app.get('/auth/passkey', async (request, reply) => {
    await assertBearerAuth(request);
    const payload = request.user as { sub: string; panel: 'admin' | 'tenant' };
    const list = await listPasskeys(app.db, payload.sub);
    const [user] = await app.db.select({ mode: users.passkeyMode }).from(users).where(eq(users.id, payload.sub)).limit(1);
    // A pod from before migration 0151 could still write 'second_factor'
    // during a rolling upgrade; it means plain passkey sign-in now.
    const mode = user?.mode === 'second_factor' ? 'alternative' : (user?.mode ?? null);
    return reply.send({ data: { passkeys: list, mode } });
  });

  /** Delete a passkey. */
  app.delete('/auth/passkey/:id', async (request, reply) => {
    await assertBearerAuth(request);
    const payload = request.user as { sub: string; panel: 'admin' | 'tenant' };
    const passkeyId = (request.params as { id: string }).id;
    await deletePasskey(app.db, payload.sub, passkeyId);
    await recordAudit(app.db, payload.sub, 'passkey_deleted', passkeyId, request);
    return reply.code(204).send();
  });

  /** Set passkey mode for the current user. */
  app.patch('/auth/passkey-mode', async (request, reply) => {
    await assertBearerAuth(request);
    const payload = request.user as { sub: string; panel: 'admin' | 'tenant' };
    const body = (request.body ?? {}) as { mode?: unknown };
    const mode = body.mode;
    if (mode !== null && mode !== 'alternative') {
      throw new ApiError('VALIDATION_ERROR', "mode must be 'alternative' or null", 400);
    }
    await setPasskeyMode(app.db, payload.sub, mode as PasskeyMode);
    await recordAudit(app.db, payload.sub, 'passkey_mode_changed', payload.sub, request, {
      mode: mode ?? null,
    });
    return reply.send({ data: { mode } });
  });
}

/**
 * Authenticated endpoints require the request to carry a Bearer JWT
 * in the Authorization header. The cookie alone (platform_session) is
 * NOT enough — defense-in-depth against CSRF: an attacker page can
 * fire a fetch with the user's cookies but cannot forge a Bearer
 * header from another origin without a token leak.
 */
async function assertBearerAuth(request: FastifyRequest): Promise<void> {
  const auth = request.headers.authorization;
  if (typeof auth !== 'string' || !auth.toLowerCase().startsWith('bearer ')) {
    throw invalidToken();
  }
  await request.jwtVerify();
  const payload = request.user as { step?: string };
  // Pre-auth tokens carry a `step` claim — they're not access tokens.
  if (payload.step) {
    throw invalidToken();
  }
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { ApiError, invalidToken } from '../../shared/errors.js';
import { auditLogs } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import {
  getStepUpStatus,
  recordStepUp,
  stepUpCredentialHolder,
  stepUpMaxAgeMs,
  verifyStepUpPassword,
  type StepUpCaller,
} from './step-up-service.js';
import {
  beginAuthentication,
  completeAuthentication,
  loadPasskeyConfig,
} from './passkey-service.js';
import { users } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  stepUpStatusQuerySchema,
  stepUpPasswordRequestSchema,
  stepUpPasskeyVerifyRequestSchema,
  type StepUpMethod,
} from '@insula/api-contracts';

// Required bearer-auth (no cookie fallback). Step-up always operates
// inside an existing session; if the caller can't present a bearer
// token, the platform-session cookie alone is not enough — same CSRF
// posture as the rest of passkey-routes.
async function assertBearerAuth(request: FastifyRequest): Promise<StepUpCaller & { panel: 'admin' | 'tenant' }> {
  const auth = request.headers.authorization;
  if (typeof auth !== 'string' || !auth.toLowerCase().startsWith('bearer ')) {
    throw invalidToken();
  }
  await request.jwtVerify();
  const payload = request.user as StepUpCaller & { step?: string; panel: 'admin' | 'tenant' };
  // Reject pre-auth tokens (they carry step:'passkey_2fa').
  if (payload.step) {
    throw invalidToken();
  }
  // An API token cannot step up (and needs not: the gated routes let it
  // through on its scopes). A step-up recorded for it would bind nothing.
  if (payload.apiToken) {
    throw new ApiError('API_TOKEN_NOT_ALLOWED', 'Step-up is for a person signed in to the panel, not an API token.', 403);
  }
  return payload;
}

/**
 * The panel the credential holder signs in to — what passkey verification
 * binds to. Under "Login as tenant" that is the staff member's (admin), not
 * the tenant panel the request comes from; the RP ID is shared by both panels,
 * so their passkey works on this origin.
 */
async function credentialPanel(db: Database, caller: StepUpCaller & { panel: 'admin' | 'tenant' }): Promise<'admin' | 'tenant'> {
  const holder = stepUpCredentialHolder(caller);
  if (holder === caller.sub) return caller.panel;
  const [row] = await db.select({ panel: users.panel }).from(users).where(eq(users.id, holder)).limit(1);
  return (row?.panel ?? 'admin') as 'admin' | 'tenant';
}

async function recordStepUpAudit(
  db: Database,
  caller: StepUpCaller,
  actionType: 'step_up.password.success' | 'step_up.password.failed' |
              'step_up.passkey.success' | 'step_up.passkey.failed',
  request: FastifyRequest,
  changes?: Record<string, unknown>,
): Promise<void> {
  // The actor is whoever's credential was checked; under impersonation the
  // row also names the tenant user being acted as.
  const actorId = stepUpCredentialHolder(caller);
  try {
    await db.insert(auditLogs).values({
      id: randomUUID(),
      tenantId: null,
      actionType,
      resourceType: 'step_up',
      resourceId: actorId,
      actorId,
      actorType: 'user',
      httpMethod: request.method,
      httpPath: request.url.slice(0, 500),
      httpStatus: actionType.endsWith('.failed') ? 401 : 200,
      changes: {
        ...(changes ?? {}),
        ...(caller.impersonatedBy ? { impersonatedBy: caller.impersonatedBy, actingAs: caller.sub } : {}),
      },
      ipAddress: request.ip,
    });
  } catch (err) {
    request.log.warn({ err }, 'step-up audit write failed');
  }
}

export async function stepUpRoutes(app: FastifyInstance): Promise<void> {
  const passkeyConfig = loadPasskeyConfig();

  /**
   * GET /me/step-up/status?purpose=node_terminal
   * Freshness of THIS session for the purpose's window, plus the methods the
   * credential holder has. Used by the panels to decide whether to prompt
   * before opening a privileged surface.
   */
  app.get('/me/step-up/status', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const caller = await assertBearerAuth(request);
    const parsed = stepUpStatusQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_ERROR',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '),
        400,
      );
    }
    const status = await getStepUpStatus(app.db, caller, stepUpMaxAgeMs(parsed.data.purpose));
    return reply.send({
      data: {
        required: status.required,
        methods: status.methods,
        lastCredentialCheckAt: status.lastCredentialCheckAt?.toISOString() ?? null,
        maxAgeSeconds: Math.floor(status.maxAgeMs / 1000),
        impersonation: status.impersonation,
        credentialEmail: status.credentialEmail,
      },
    });
  });

  /**
   * POST /me/step-up/password
   * Verifies the credential holder's password (the staff member's own under
   * "Login as tenant") and records the step-up for this session.
   * Rate-limited tighter than /auth/login because the user is already
   * authenticated — repeated step-up failures are bot-style probing.
   */
  app.post('/me/step-up/password', {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
  }, async (request, reply) => {
    const caller = await assertBearerAuth(request);
    const parsed = stepUpPasswordRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_ERROR',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '),
        400,
      );
    }
    try {
      await verifyStepUpPassword(app.db, stepUpCredentialHolder(caller), parsed.data.password);
      const at = await recordStepUp(app.db, caller, 'password');
      await recordStepUpAudit(app.db, caller, 'step_up.password.success', request);
      const method: StepUpMethod = 'password';
      return reply.send({
        data: {
          ok: true as const,
          methodVerified: method,
          lastCredentialCheckAt: at.toISOString(),
        },
      });
    } catch (err) {
      // Best-effort audit on failure — the user is real (bearer-auth
      // already verified the JWT) so we know who attempted.
      await recordStepUpAudit(app.db, caller, 'step_up.password.failed', request, {
        reason: err instanceof ApiError ? err.code : 'unknown',
      });
      throw err;
    }
  });

  /**
   * POST /me/step-up/passkey/options
   * Begin a passkey step-up challenge scoped to the credential holder (NOT
   * userless — the user is already known). On success the client receives a
   * WebAuthn PublicKeyCredentialRequestOptionsJSON.
   */
  app.post('/me/step-up/passkey/options', {
    config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const caller = await assertBearerAuth(request);
    const holder = stepUpCredentialHolder(caller);
    const options = await beginAuthentication(app.db, passkeyConfig, await credentialPanel(app.db, caller), holder);
    return reply.send({ data: options });
  });

  /**
   * POST /me/step-up/passkey/verify
   * Complete the passkey step-up for the credential holder and record it for
   * this session.
   */
  app.post('/me/step-up/passkey/verify', {
    config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const caller = await assertBearerAuth(request);
    const holder = stepUpCredentialHolder(caller);
    const parsed = stepUpPasskeyVerifyRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_ERROR',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '),
        400,
      );
    }
    try {
      const result = await completeAuthentication(app.db, passkeyConfig, {
        panel: await credentialPanel(app.db, caller),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response: parsed.data.response as any,
        expectedUserId: holder,
      });
      // Reject cross-user passkey reuse — completeAuthentication
      // already enforces this via expectedUserId, but be belt-and-braces.
      if (result.user.id !== holder) {
        throw new ApiError('STEP_UP_FAILED', 'Step-up authentication failed', 401);
      }
      const at = await recordStepUp(app.db, caller, 'passkey');
      await recordStepUpAudit(app.db, caller, 'step_up.passkey.success', request, {
        passkeyId: result.passkeyId,
      });
      const method: StepUpMethod = 'passkey';
      return reply.send({
        data: {
          ok: true as const,
          methodVerified: method,
          lastCredentialCheckAt: at.toISOString(),
        },
      });
    } catch (err) {
      await recordStepUpAudit(app.db, caller, 'step_up.passkey.failed', request, {
        reason: err instanceof ApiError ? err.code : 'unknown',
      });
      throw err;
    }
  });
}

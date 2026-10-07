/**
 * Authenticator-app (TOTP) second factor — the user's own management routes
 * and step 2 of a password sign-in. Storage and rules: totp-service.ts.
 *
 *   GET  /auth/totp                  status
 *   POST /auth/totp/setup            new secret + otpauth URI (shown once)
 *   POST /auth/totp/enable           { code }            → backup codes (shown once)
 *   POST /auth/totp/disable          { code | backup_code }
 *   POST /auth/totp/backup-codes     { code | backup_code } → new backup codes
 *   POST /auth/totp/login/verify     { pre_auth_token, code | backup_code } → session
 *
 * Management needs an access token of the account OWNER: an admin
 * impersonating a tenant user must not be able to switch the factor on (that
 * would lock the user out of their own password sign-in) or off.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  totpDisableSchema,
  totpEnableSchema,
  totpLoginVerifySchema,
  totpRegenerateBackupCodesSchema,
} from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import { auditLogs, users } from '../../db/schema.js';
import { ApiError, invalidToken } from '../../shared/errors.js';
import { verifyAccessToken } from '../../middleware/auth.js';
import { isLocalAuthDisabled } from '../oidc/service.js';
import { getSettings } from '../system-settings/service.js';
import { consumePreAuthToken, verifyPreAuthToken, type Panel } from './pre-auth.js';
import { issueSession } from './session.js';
import {
  beginTotpSetup,
  disableTotp,
  enableTotp,
  getTotpStatus,
  regenerateBackupCodes,
  verifyTotpFactor,
  type TotpProof,
} from './totp-service.js';

function parseBody<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } } }, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new ApiError('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '), 400);
  }
  return parsed.data;
}

function proofOf(input: { code?: string; backup_code?: string }): TotpProof {
  return input.code !== undefined ? { code: input.code } : { backupCode: input.backup_code as string };
}

async function recordAudit(
  db: Database,
  request: FastifyRequest,
  userId: string,
  actionType: string,
  changes?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: randomUUID(),
      tenantId: null,
      actionType,
      resourceType: 'totp',
      resourceId: userId,
      actorId: userId,
      actorType: 'user',
      httpMethod: request.method,
      httpPath: request.url.slice(0, 500),
      httpStatus: 200,
      changes: changes ?? null,
      ipAddress: request.ip,
    });
  } catch (err) {
    request.log.warn({ err: err instanceof Error ? err.message : String(err) }, `[totp] audit insert failed for ${actionType}`);
  }
}

export async function totpRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey = (): string => (app.config as unknown as { PLATFORM_ENCRYPTION_KEY: string }).PLATFORM_ENCRYPTION_KEY;

  /** The signed-in account owner — never an impersonation token. */
  async function owner(request: FastifyRequest): Promise<{ sub: string; panel: Panel }> {
    const auth = request.headers.authorization;
    if (typeof auth !== 'string' || !auth.toLowerCase().startsWith('bearer ')) throw invalidToken();
    await verifyAccessToken(request);
    const payload = request.user as { sub: string; panel?: string; impersonatedBy?: string };
    if (payload.impersonatedBy) {
      throw new ApiError('IMPERSONATION_FORBIDDEN',
        'Two-step sign-in belongs to the account owner and cannot be changed while impersonating.', 403);
    }
    return { sub: payload.sub, panel: payload.panel === 'tenant' ? 'tenant' : 'admin' };
  }

  app.get('/auth/totp', async (request) => {
    const me = await owner(request);
    return { data: await getTotpStatus(app.db, me.sub) };
  });

  app.post('/auth/totp/setup', async (request) => {
    const me = await owner(request);
    const [user] = await app.db.select({ email: users.email }).from(users).where(eq(users.id, me.sub)).limit(1);
    if (!user) throw invalidToken();
    const { platformName } = await getSettings(app.db);
    const issuer = me.panel === 'admin' ? `${platformName} Admin` : platformName;
    const setup = await beginTotpSetup(app.db, encryptionKey(), { userId: me.sub, account: user.email, issuer });
    return { data: setup };
  });

  app.post('/auth/totp/enable', async (request) => {
    const me = await owner(request);
    const { code } = parseBody(totpEnableSchema, request.body);
    const backupCodes = await enableTotp(app.db, encryptionKey(), me.sub, code);
    await recordAudit(app.db, request, me.sub, 'totp_enabled');
    return { data: { backupCodes } };
  });

  app.post('/auth/totp/disable', async (request) => {
    const me = await owner(request);
    const input = parseBody(totpDisableSchema, request.body);
    await disableTotp(app.db, encryptionKey(), me.sub, proofOf(input));
    await recordAudit(app.db, request, me.sub, 'totp_disabled', { factor: input.code !== undefined ? 'code' : 'backup_code' });
    return { data: { enabled: false } };
  });

  app.post('/auth/totp/backup-codes', async (request) => {
    const me = await owner(request);
    const input = parseBody(totpRegenerateBackupCodesSchema, request.body);
    const backupCodes = await regenerateBackupCodes(app.db, encryptionKey(), me.sub, proofOf(input));
    await recordAudit(app.db, request, me.sub, 'totp_backup_codes_regenerated');
    return { data: { backupCodes } };
  });

  // Step 2 of a password sign-in. Rate-limited per IP on top of the per-user
  // lockout in the service (which is what actually bounds guessing).
  app.post('/auth/totp/login/verify', {
    config: { rateLimit: { max: 30, timeWindow: '5 minutes' } },
  }, async (request, reply) => {
    const body = (request.body ?? {}) as { panel?: unknown };
    const panel: Panel = body.panel === 'tenant' ? 'tenant' : 'admin';
    if (await isLocalAuthDisabled(app.db, panel)) {
      throw new ApiError('LOCAL_AUTH_DISABLED', 'Local authentication is disabled. Please use SSO to sign in.', 403);
    }
    const { panel: _panel, ...rest } = request.body as Record<string, unknown>;
    void _panel;
    const input = parseBody(totpLoginVerifySchema, rest);
    const claims = verifyPreAuthToken(app, input.pre_auth_token, 'totp_2fa', panel);
    // The factor first, the token second: a mistyped code must not cost the
    // user their password step. Guessing is bounded by the per-user lockout.
    const factor = await verifyTotpFactor(app.db, encryptionKey(), claims.sub, proofOf(input));
    await consumePreAuthToken(app.db, claims, 'totp_2fa', panel);

    const [user] = await app.db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
    if (!user || user.status !== 'active') throw invalidToken();
    const session = await issueSession(app, request, reply, {
      id: user.id, email: user.email, fullName: user.fullName, role: user.roleName,
      panel: user.panel, tenantId: user.tenantId,
    });
    await recordAudit(app.db, request, user.id, 'totp_login', { factor });
    return reply.send({ data: session });
  });
}

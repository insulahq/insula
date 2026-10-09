/**
 * The bridge between step 1 (password right) and step 2 (second factor) of a
 * sign-in: a short-lived JWT that is NOT an access token, plus a server-side
 * single-use record so a stolen one cannot be replayed against another
 * replica (platform-api runs up to 3).
 *
 * The JWT carries a `step` claim; the access-token verifiers reject any token
 * that has one, so a pre-auth token can never be used as a session.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { authConsumedTokens, users } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';

export const PRE_AUTH_TOKEN_TTL_SECONDS = 5 * 60;

export type PreAuthStep = 'totp_2fa';
export type Panel = 'admin' | 'tenant';

export function signPreAuthToken(
  app: FastifyInstance,
  input: { readonly userId: string; readonly panel: Panel; readonly step: PreAuthStep },
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: input.userId,
    panel: input.panel,
    step: input.step,
    exp: now + PRE_AUTH_TOKEN_TTL_SECONDS,
    iat: now,
    jti: randomUUID(),
  };
  // @fastify/jwt types its payload as the ACCESS token's; this one is not.
  return app.jwt.sign(payload as unknown as Parameters<typeof app.jwt.sign>[0]);
}

export interface PreAuthClaims {
  readonly sub: string;
  readonly jti: string;
}

/** Signature, expiry, step and panel. Does not consume — see consumePreAuthToken. */
export function verifyPreAuthToken(
  app: FastifyInstance,
  token: string,
  step: PreAuthStep,
  panel: Panel,
): PreAuthClaims {
  let decoded: { sub?: string; panel?: string; step?: string; jti?: string };
  try {
    decoded = app.jwt.verify(token) as typeof decoded;
  } catch {
    throw new ApiError('PRE_AUTH_TOKEN_INVALID', 'The sign-in step expired. Enter your password again.', 401);
  }
  if (decoded.step !== step || !decoded.sub || !decoded.jti) {
    throw new ApiError('PRE_AUTH_TOKEN_INVALID', 'The sign-in step expired. Enter your password again.', 401);
  }
  if (decoded.panel !== panel) {
    throw new ApiError('PRE_AUTH_TOKEN_PANEL_MISMATCH', 'This sign-in belongs to the other panel.', 401);
  }
  return { sub: decoded.sub, jti: decoded.jti };
}

/**
 * Mark the token used. The primary key on jti makes the first insert win and
 * every replay fail, across replicas, without a transaction. Also re-checks
 * the user still belongs to the panel the token was issued for.
 */
export async function consumePreAuthToken(
  db: Database,
  claims: PreAuthClaims,
  step: PreAuthStep,
  panel: Panel,
): Promise<void> {
  try {
    await db.insert(authConsumedTokens).values({
      jti: claims.jti,
      userId: claims.sub,
      purpose: step,
      expiresAt: new Date(Date.now() + PRE_AUTH_TOKEN_TTL_SECONDS * 1000),
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new ApiError('PRE_AUTH_TOKEN_REPLAY', 'This sign-in step was already used. Enter your password again.', 401);
    }
    throw err;
  }
  const [user] = await db.select({ panel: users.panel }).from(users).where(eq(users.id, claims.sub)).limit(1);
  if (!user || (user.panel ?? 'admin') !== panel) {
    throw new ApiError('PRE_AUTH_TOKEN_PANEL_MISMATCH', 'This sign-in belongs to the other panel.', 401);
  }
}

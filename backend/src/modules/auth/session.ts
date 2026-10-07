/**
 * Finishing a sign-in: the access JWT, the DB-backed refresh token, the two
 * session cookies and the response body. Password, passkey and
 * password-plus-TOTP sign-ins all end here, so they cannot drift apart.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PLATFORM_SESSION_COOKIE } from '../../middleware/auth.js';
import { signAccessToken } from './access-token.js';
import {
  issueRefreshToken,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from './refresh-token-service.js';

export const REFRESH_COOKIE = 'platform_refresh';

export function buildSessionCookie(name: string, token: string, maxAge: number): string {
  const domain = process.env.SESSION_COOKIE_DOMAIN;
  // Cross-subdomain sharing (dev/dind) needs SameSite=None; host-only stays Lax.
  const sameSite = domain ? 'None' : 'Lax';
  const parts = [
    `${name}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    `SameSite=${sameSite}`,
    `Max-Age=${maxAge}`,
  ];
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
}

export function setSessionCookies(reply: FastifyReply, accessToken: string, refreshToken: string): void {
  reply.header('Set-Cookie', [
    buildSessionCookie(PLATFORM_SESSION_COOKIE, accessToken, ACCESS_TOKEN_TTL_SECONDS),
    buildSessionCookie(REFRESH_COOKIE, refreshToken, REFRESH_TOKEN_TTL_SECONDS),
  ]);
}

export function pickUserAgent(request: FastifyRequest): string | undefined {
  const ua = request.headers['user-agent'];
  if (typeof ua === 'string') return ua;
  if (Array.isArray(ua)) return ua[0];
  return undefined;
}

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: string;
  readonly panel: string | null;
  readonly tenantId: string | null;
}

export interface SessionResponseData {
  readonly token: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly refreshExpiresIn: number;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly fullName: string;
    readonly role: string;
    readonly panel: string | null;
    readonly tenantId: string | null;
  };
}

/** Issue the session for a user whose sign-in has fully succeeded. */
export async function issueSession(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  user: SessionUser,
): Promise<SessionResponseData> {
  const panel = (user.panel ?? 'admin') as 'admin' | 'tenant';
  const accessToken = signAccessToken(app, {
    userId: user.id,
    role: user.role,
    panel,
    tenantId: user.tenantId,
  });
  const issued = await issueRefreshToken(app.db, {
    userId: user.id,
    panel,
    tenantId: user.tenantId ?? null,
    userAgent: pickUserAgent(request),
    ipAddress: request.ip,
  });
  setSessionCookies(reply, accessToken, issued.token);
  return {
    token: accessToken,
    refreshToken: issued.token,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    refreshExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      panel: user.panel,
      tenantId: user.tenantId,
    },
  };
}

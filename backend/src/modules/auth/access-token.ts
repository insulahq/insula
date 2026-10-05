/**
 * The access-JWT signer — the one place an access token's claims are built.
 *
 * Extracted from routes.ts (login / refresh) so a server-side background run
 * acting for a user (a DR recovery driving the provision and restore routes)
 * mints EXACTLY the token those routes verify: same key (`app.jwt`), same
 * claims, same `authenticate` path. It only ever shortens the lifetime, and
 * may stamp `via` — an extra claim `authenticate` ignores — so a token minted
 * by a background run is distinguishable from a session token in a decoded
 * request. Never persist or log what this returns.
 */

import type { FastifyInstance } from 'fastify';
import { ACCESS_TOKEN_TTL_SECONDS } from './refresh-token-service.js';

export interface AccessTokenInput {
  readonly userId: string;
  readonly role: string;
  readonly panel: 'admin' | 'tenant';
  readonly tenantId?: string | null;
  readonly impersonatedBy?: string;
}

export interface AccessTokenOptions {
  /** Shorter than a session token only; capped at ACCESS_TOKEN_TTL_SECONDS. */
  readonly ttlSeconds?: number;
  /** What minted it, when it was not a sign-in (e.g. `dr-recover-task`). */
  readonly via?: string;
}

export function signAccessToken(
  app: FastifyInstance,
  input: AccessTokenInput,
  options: AccessTokenOptions = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.min(options.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS, ACCESS_TOKEN_TTL_SECONDS);
  const payload: Record<string, unknown> = {
    sub: input.userId,
    role: input.role,
    panel: input.panel,
    exp: now + ttl,
    iat: now,
    jti: crypto.randomUUID(),
  };
  if (input.tenantId) payload.tenantId = input.tenantId;
  if (input.impersonatedBy) payload.impersonatedBy = input.impersonatedBy;
  if (options.via) payload.via = options.via;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return app.jwt.sign(payload as any);
}

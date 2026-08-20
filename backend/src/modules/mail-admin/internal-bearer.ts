/**
 * Bearer authentication for this module's `/internal/*` endpoints.
 *
 * These routes are called machine-to-machine — the snapshot upload sidecar and
 * the mail-stack-standby-replicate DaemonSet — with a PLATFORM_INTERNAL_SECRET
 * bearer token rather than a user JWT. The `mailAdminRoutes` plugin attaches
 * plugin-wide `authenticate` + `requireRole` onRequest hooks, so these routes
 * set `skipAuth: true` and do their own check here instead.
 *
 * Extracted from routes.ts because the check was copy-pasted per route and
 * every copy compared the shared secret with `!==` — a non-constant-time
 * compare of a value that every sibling module (sftp-users, private-workers,
 * system-tenant) already compares with timingSafeEqual. One helper means one
 * place to get it right, and a place to test it.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../../shared/errors.js';

/**
 * Constant-time compare of two secrets.
 *
 * `timingSafeEqual` throws when the buffers differ in length, and that throw
 * would itself leak the expected length, so both sides are hashed to a fixed
 * 32 bytes first. Same shape as `private-workers/internal-routes.ts`.
 */
export function safeSecretEqual(received: string, expected: string): boolean {
  const a = createHash('sha256').update(received, 'utf-8').digest();
  const b = createHash('sha256').update(expected, 'utf-8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Throws unless `headers` carry the correct internal bearer token.
 *
 * Accepts either env-var name — PLATFORM_INTERNAL_SECRET is canonical across
 * config/index.ts, file-manager and private-workers, and is what the
 * Deployments actually set; PLATFORM_INTERNAL_TOKEN is honoured so existing
 * installs keep working without a Deployment-side rename.
 *
 * Fails closed (503) when neither is set: an unconfigured install must reject
 * these calls, never wave them through.
 */
export function assertInternalBearer(
  headers: Record<string, string | string[] | undefined>,
): void {
  const expectedToken = process.env.PLATFORM_INTERNAL_SECRET
    ?? process.env.PLATFORM_INTERNAL_TOKEN;
  if (!expectedToken) {
    throw new ApiError(
      'INTERNAL_TOKEN_NOT_CONFIGURED',
      'PLATFORM_INTERNAL_SECRET env var must be set for /internal/* endpoints',
      503,
    );
  }
  const auth = headers['authorization'] ?? '';
  const token = Array.isArray(auth) ? auth[0] : auth;
  if (!token.startsWith('Bearer ') || !safeSecretEqual(token.slice(7), expectedToken)) {
    throw new ApiError('UNAUTHORIZED', 'Invalid internal token', 401);
  }
}

/**
 * Route options for the bearer-gated `/internal/*` endpoints in this module.
 *
 * `rateLimit: false` — the global limiter keys on `user.sub ?? request.ip`, and
 * these callers carry no JWT, so every node's reports would share ONE
 * 100-req/min bucket. A cluster reporting on its 5-minute standby-replicate
 * cycle would throttle itself and silently drop the freshness data the operator
 * surface renders. `assertInternalBearer` is the control that applies here.
 */
export const INTERNAL_BEARER_ROUTE = {
  config: { skipAuth: true, rateLimit: false },
} as const;

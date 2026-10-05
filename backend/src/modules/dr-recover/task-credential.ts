/**
 * The credential a recovery's internal calls carry.
 *
 * The orchestration drives the provision and restore-cart routes through
 * `app.inject`, so every step needs an `Authorization` header those routes
 * accept. Two sources:
 *
 *  - The SYNCHRONOUS route forwards its caller's header, unchanged — the run
 *    lives inside that request.
 *  - A BACKGROUND run never holds the operator's token. It outlives the
 *    request by minutes to hours (a whole batch, tenant after tenant); a
 *    30-minute session token would expire mid-run, and a forwarded token
 *    would keep a disabled or demoted admin's authority driving destructive
 *    steps. Instead, before EVERY internal call it re-reads the user who
 *    started the run — still there, still active, still an admin — and mints
 *    a fresh short-lived token for them with the auth module's own signer
 *    (same key, same claims, `via: 'dr-recover-task'`). The token exists only
 *    in the header of the call it was minted for: never stored, never logged.
 *
 * The same precedent exists for the platform-ops CLI (cli/dr-tenant-recover.ts),
 * which mints a short admin token for a real active admin to call this route.
 */

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { users } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { signAccessToken } from '../auth/access-token.js';

/** Supplies the `Authorization` header for the next internal call. */
export type AuthProvider = () => Promise<string>;

/** Long enough for one internal call to pass `authenticate`; nothing more. */
export const TASK_TOKEN_TTL_SECONDS = 5 * 60;
export const TASK_TOKEN_VIA = 'dr-recover-task';

/** What the recover route — and every route it drives — requires. */
const RECOVER_ROLES: ReadonlySet<string> = new Set(['super_admin', 'admin']);

export function forwardedAuth(header: string): AuthProvider {
  return async () => header;
}

function initiatorLostAccess(userId: string, reason: string): ApiError {
  return new ApiError(
    'DR_INITIATOR_NO_ACCESS',
    `The operator who started this recovery no longer has access (${reason}) — start it again.`,
    403,
    {
      userId,
      operatorError: {
        code: 'DR_INITIATOR_NO_ACCESS',
        title: 'The operator who started this recovery no longer has access',
        detail: `The recovery acts for the admin who started it, and checks before every step that they still may. They cannot: ${reason}. It stopped at this step.`,
        remediation: [
          'An active admin must start the recovery again — it re-applies everything from the bundle.',
        ],
        retryable: false,
      },
    },
  );
}

/** Why `user` may no longer drive a recovery, or null when it may. */
function disqualification(user: { status: string; panel: string; roleName: string } | undefined): string | null {
  if (!user) return 'their account no longer exists';
  if (user.status !== 'active') return `their account is ${user.status}`;
  if (user.panel !== 'admin' || !RECOVER_ROLES.has(user.roleName)) return `their role is now ${user.roleName}`;
  return null;
}

/**
 * A provider that re-validates `userId` live and mints a fresh token per call.
 * Throws `DR_INITIATOR_NO_ACCESS` (with an OperatorError) the moment the user
 * no longer qualifies — the run fails on the step that was about to run.
 */
export function taskMintedAuth(app: FastifyInstance, userId: string): AuthProvider {
  return async () => {
    const [user] = await app.db
      .select({ id: users.id, roleName: users.roleName, panel: users.panel, status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const reason = disqualification(user);
    if (reason || !user) throw initiatorLostAccess(userId, reason ?? 'their account no longer exists');
    const token = signAccessToken(
      app,
      { userId: user.id, role: user.roleName, panel: 'admin' },
      { ttlSeconds: TASK_TOKEN_TTL_SECONDS, via: TASK_TOKEN_VIA },
    );
    return `Bearer ${token}`;
  };
}

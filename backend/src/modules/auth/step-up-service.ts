import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { users } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { verifyPassword } from './service.js';
import type { StepUpMethod, StepUpPurpose } from '@insula/api-contracts';

// Default freshness window for any step-up-gated operation. 30 minutes
// matches typical session-step-up windows in IAM products and gives
// the operator a friction-free workflow while still expiring a stale
// session before a privileged action.
export const DEFAULT_STEP_UP_MAX_AGE_MS = 30 * 60 * 1000;

export interface StepUpStatus {
  readonly required: boolean;
  readonly methods: readonly StepUpMethod[];
  readonly lastCredentialCheckAt: Date | null;
  readonly maxAgeMs: number;
}

/**
 * Returns whether the user must re-authenticate to perform a privileged
 * action, plus the methods they have available. NEVER throws — a
 * non-existent or inactive user simply returns `required:true` with an
 * empty methods array, which the caller surfaces as STEP_UP_REQUIRED.
 *
 * Freshness clock:
 *   • `lastCredentialCheckAt IS NULL`  → required = true
 *   • `now - lastCredentialCheckAt > maxAgeMs` → required = true
 *   • otherwise required = false
 *
 * Method enumeration:
 *   • passwordHash present  → 'password' available
 *   • passkeyMode IN ('alternative','second_factor') → 'passkey' available
 *
 * Users with NO method available (passwordHash NULL AND passkeyMode NULL —
 * happens with OIDC-only accounts) return `required:true, methods:[]` —
 * the caller MUST 409 the operation as STEP_UP_UNAVAILABLE since there
 * is no way to step up.
 */
export async function getStepUpStatus(
  db: Database,
  userId: string,
  maxAgeMs: number = DEFAULT_STEP_UP_MAX_AGE_MS,
): Promise<StepUpStatus> {
  const [user] = await db
    .select({
      passwordHash: users.passwordHash,
      passkeyMode: users.passkeyMode,
      status: users.status,
      lastStepUpAt: users.lastStepUpAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user || user.status !== 'active') {
    return { required: true, methods: [], lastCredentialCheckAt: null, maxAgeMs };
  }

  const methods: StepUpMethod[] = [];
  if (user.passwordHash) methods.push('password');
  if (user.passkeyMode === 'alternative' || user.passkeyMode === 'second_factor') {
    methods.push('passkey');
  }

  // Gate on lastStepUpAt — bumped ONLY by explicit step-up endpoints,
  // NOT by login/passkey-verify/OIDC. The first privileged action
  // after login therefore always requires step-up; subsequent actions
  // within the freshness window skip the prompt.
  const last = user.lastStepUpAt;
  if (!last) {
    return { required: true, methods, lastCredentialCheckAt: null, maxAgeMs };
  }
  const ageMs = Date.now() - last.getTime();
  const required = ageMs > maxAgeMs;
  return { required, methods, lastCredentialCheckAt: last, maxAgeMs };
}

/**
 * `config.apiTokenForbidden` reason for step-up-gated routes. An API token or
 * an agent cannot step up (the step-up endpoints take a session), so without
 * this a token would pass whenever its user had stepped up in the panel
 * within the window — a gate that depends on unrelated timing.
 */
export const STEP_UP_SESSION_ONLY =
  'hands out key material after a fresh sign-in check, which only a person signed in to the panel can give';

/** The token claims the gate reads. */
export interface StepUpCaller {
  readonly sub: string;
  readonly impersonatedBy?: string;
}

/**
 * The server-side gate for an action that hands out key material: throws
 * unless the caller stepped up within the freshness window.
 *
 *   403 STEP_UP_REQUIRED     a method exists; `details.methods` lists them so
 *                            the panel can ask, then retry the request
 *   409 STEP_UP_UNAVAILABLE  the account has no password and no passkey
 *                            (OIDC-only), so there is nothing to step up with
 *   403 IMPERSONATION_FORBIDDEN  "Login as tenant": the step-up endpoints
 *                            check the TOKEN's user — the tenant — whose
 *                            credential the operator does not hold, and a
 *                            key released to the operator must not be
 *                            recorded as the tenant's own action
 *
 * The check runs on the server for every request; the panel's dialog only
 * saves a round trip.
 */
export async function assertFreshStepUp(
  db: Database,
  caller: StepUpCaller,
  purpose: StepUpPurpose,
): Promise<void> {
  if (caller.impersonatedBy) {
    throw new ApiError(
      'IMPERSONATION_FORBIDDEN',
      'Key material is released only to the signed-in account owner, not while impersonating.',
      403,
      { purpose },
    );
  }
  const status = await getStepUpStatus(db, caller.sub, DEFAULT_STEP_UP_MAX_AGE_MS);
  if (!status.required) return;
  if (status.methods.length === 0) {
    throw new ApiError(
      'STEP_UP_UNAVAILABLE',
      'Confirming it is you needs a password or a passkey on your account, and yours has neither. Register a passkey and turn on passkey sign-in under User settings, then try again.',
      409,
      { reason: 'NO_STEP_UP_METHOD_AVAILABLE', purpose },
    );
  }
  throw new ApiError(
    'STEP_UP_REQUIRED',
    'Confirm it is you before this is shown.',
    403,
    {
      purpose,
      methods: status.methods,
      lastCredentialCheckAt: status.lastCredentialCheckAt?.toISOString() ?? null,
      maxAgeSeconds: Math.floor(status.maxAgeMs / 1000),
    },
    'POST /api/v1/me/step-up/{password|passkey/verify} with your active credential, then retry.',
  );
}

/**
 * Verify a password as a step-up challenge. Does NOT issue session
 * tokens; only proves the credential and bumps the freshness clock so
 * subsequent privileged operations succeed.
 *
 * Throws ApiError on bad credentials. Mirror of `verifyPassword` in
 * auth/service.ts but scoped to step-up so we can keep the rate-limit
 * + audit semantics distinct.
 */
export async function verifyStepUpPassword(
  db: Database,
  userId: string,
  password: string,
): Promise<Date> {
  if (!password) {
    throw new ApiError('VALIDATION_ERROR', 'Password is required', 400);
  }
  const [user] = await db
    .select({
      id: users.id,
      passwordHash: users.passwordHash,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user || user.status !== 'active') {
    throw new ApiError('STEP_UP_FAILED', 'Step-up authentication failed', 401);
  }
  if (!user.passwordHash) {
    throw new ApiError('STEP_UP_METHOD_UNAVAILABLE',
      'Password step-up is not configured for this account', 409);
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    throw new ApiError('STEP_UP_FAILED', 'Step-up authentication failed', 401);
  }

  const now = new Date();
  // Bump BOTH timestamps — lastCredentialCheckAt for any general
  // "was the user active recently" check, and lastStepUpAt for the
  // explicit step-up freshness clock the privileged-action gate uses.
  await db
    .update(users)
    .set({ lastCredentialCheckAt: now, lastStepUpAt: now })
    .where(eq(users.id, userId));
  return now;
}

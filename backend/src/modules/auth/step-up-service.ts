import { and, eq, lt, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { authStepUps, users } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { verifyPassword } from './service.js';
import type { StepUpMethod, StepUpPurpose } from '@insula/api-contracts';

// Freshness window of the node terminal. 30 minutes matches typical
// session-step-up windows in IAM products and gives the operator a
// friction-free workflow while still expiring a stale session before a
// privileged action.
export const DEFAULT_STEP_UP_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Freshness window for handing out key material (a DKIM private key, a
 * certificate bundle, a link that fetches one). Short: the step-up is asked
 * for right before the key leaves, not as a session-long unlock.
 */
export const KEY_MATERIAL_STEP_UP_MAX_AGE_MS = 5 * 60 * 1000;

/** The window each purpose is judged against. */
export function stepUpMaxAgeMs(purpose: StepUpPurpose): number {
  return purpose === 'node_terminal' ? DEFAULT_STEP_UP_MAX_AGE_MS : KEY_MATERIAL_STEP_UP_MAX_AGE_MS;
}

/** A step-up row older than this is dead: every window is shorter. */
const STEP_UP_ROW_TTL_MS = 24 * 60 * 60 * 1000;

/** Wrong step-up passwords a credential holder may make per window, then 429. */
export const STEP_UP_MAX_FAILED_PASSWORDS = 5;
export const STEP_UP_FAILED_WINDOW_MS = 15 * 60 * 1000;

/**
 * Staff roles that may take key material out under "Login as tenant". Support
 * may impersonate (to look), but holds no customer's private key, as it does
 * not on the admin panel's own routes.
 */
const KEY_MATERIAL_IMPERSONATOR_ROLES: ReadonlySet<string> = new Set(['super_admin', 'admin']);

/** The token claims the step-up reads. */
export interface StepUpCaller {
  readonly sub: string;
  /** The session the token belongs to: its refresh-token family, or the impersonation token. */
  readonly sid?: string;
  readonly jti?: string;
  readonly impersonatedBy?: string;
  /** Present on a request made with an API token. */
  readonly apiToken?: unknown;
}

/**
 * The session a step-up is recorded against and checked for. A token minted
 * before `sid` existed falls back to its own `jti`: a step-up then covers that
 * one token, and its refreshed successor asks again.
 */
export function stepUpSessionId(caller: StepUpCaller): string | null {
  return caller.sid ?? caller.jti ?? null;
}

/**
 * Whose credential a step-up checks. Under "Login as tenant" the token's user
 * is the tenant's, whose password the staff member does not hold: the staff
 * member confirms with their own.
 */
export function stepUpCredentialHolder(caller: StepUpCaller): string {
  return caller.impersonatedBy ?? caller.sub;
}

/**
 * Who really acted, for the audit row of a key hand-out: the staff member
 * behind "Login as tenant", or the API token a script or agent used. Empty
 * for a plain session.
 */
export function attributionOf(user: unknown): Record<string, unknown> {
  const u = (user ?? {}) as { impersonatedBy?: string; apiToken?: { tokenId?: string; name?: string; via?: string } };
  return {
    ...(u.impersonatedBy ? { impersonatedBy: u.impersonatedBy } : {}),
    ...(u.apiToken ? { via: u.apiToken.via, apiTokenId: u.apiToken.tokenId, apiTokenName: u.apiToken.name } : {}),
  };
}

export interface StepUpStatus {
  readonly required: boolean;
  readonly methods: readonly StepUpMethod[];
  readonly lastCredentialCheckAt: Date | null;
  readonly maxAgeMs: number;
  /** True when the credential asked for is not the token user's own (impersonation). */
  readonly impersonation: boolean;
  /** The credential holder's email, under impersonation (the dialog names it). */
  readonly credentialEmail: string | null;
}

/**
 * Whether this SESSION must step up before a privileged action, and with what.
 * NEVER throws — a non-existent or inactive credential holder returns
 * `required:true` with no methods, which the caller surfaces as
 * STEP_UP_UNAVAILABLE.
 *
 * Freshness: the session's row in auth_step_ups, written ONLY by the explicit
 * step-up endpoints (never by sign-in), for the same credential holder, no
 * older than `maxAgeMs`. Another session of the same user has no row and is
 * asked again — a stolen token gains nothing from its owner's step-up.
 *
 * Methods: the credential holder's password (passwordHash set) and passkey
 * (passkeyMode 'alternative' or 'second_factor'). An OIDC-only account has
 * neither and gets `methods: []`.
 */
export async function getStepUpStatus(
  db: Database,
  caller: StepUpCaller,
  maxAgeMs: number = DEFAULT_STEP_UP_MAX_AGE_MS,
): Promise<StepUpStatus> {
  const holder = stepUpCredentialHolder(caller);
  const impersonation = holder !== caller.sub;
  const [user] = await db
    .select({
      email: users.email,
      passwordHash: users.passwordHash,
      passkeyMode: users.passkeyMode,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, holder))
    .limit(1);

  const credentialEmail = impersonation ? user?.email ?? null : null;
  if (!user || user.status !== 'active') {
    return { required: true, methods: [], lastCredentialCheckAt: null, maxAgeMs, impersonation, credentialEmail };
  }

  const methods: StepUpMethod[] = [];
  if (user.passwordHash) methods.push('password');
  if (user.passkeyMode === 'alternative' || user.passkeyMode === 'second_factor') {
    methods.push('passkey');
  }

  const sessionId = stepUpSessionId(caller);
  const [row] = sessionId
    ? await db
      .select({ at: authStepUps.steppedUpAt })
      .from(authStepUps)
      .where(and(eq(authStepUps.sessionId, sessionId), eq(authStepUps.userId, holder)))
      .limit(1)
    : [];
  const last = row?.at ?? null;
  const required = !last || Date.now() - last.getTime() > maxAgeMs;
  return { required, methods, lastCredentialCheckAt: last, maxAgeMs, impersonation, credentialEmail };
}

/**
 * Record a successful step-up for the caller's session. Also prunes dead
 * rows (cheap: indexed) and keeps users.last_step_up_at as "when did this
 * person last step up anywhere", for display only — no gate reads it.
 */
export async function recordStepUp(
  db: Database,
  caller: StepUpCaller,
  method: StepUpMethod,
): Promise<Date> {
  const sessionId = stepUpSessionId(caller);
  if (!sessionId) {
    // Every session token carries a sid or a jti; a token without either is
    // not one, and a step-up it made could never be found again.
    throw new ApiError('STEP_UP_NO_SESSION', 'This token has no session to step up for. Sign in again.', 400);
  }
  const holder = stepUpCredentialHolder(caller);
  const now = new Date();
  await db
    .insert(authStepUps)
    .values({ sessionId, userId: holder, method, steppedUpAt: now })
    .onConflictDoUpdate({
      target: authStepUps.sessionId,
      set: { userId: holder, method, steppedUpAt: now },
    });
  await db.update(users).set({ lastStepUpAt: now }).where(eq(users.id, holder));
  await db
    .delete(authStepUps)
    .where(lt(authStepUps.steppedUpAt, sql`now() - ${`${STEP_UP_ROW_TTL_MS / 1000} seconds`}::interval`));
  return now;
}

/**
 * The server-side gate for an action that hands out key material: throws
 * unless this session stepped up within the purpose's window.
 *
 *   403 STEP_UP_REQUIRED     a method exists; `details` (stepUpRequiredDetails
 *                            in the contracts) lists the methods and says
 *                            whose credential is asked for, so the panel can
 *                            ask, then retry the request
 *   409 STEP_UP_UNAVAILABLE  the credential holder has no password and no
 *                            passkey (OIDC-only), so there is nothing to step
 *                            up with
 *
 *   403 IMPERSONATOR_ROLE_NOT_ALLOWED  under "Login as tenant", the staff
 *                            member's CURRENT role (read from the database,
 *                            not the token) is not super_admin or admin
 *
 * An API token passes: it cannot step up, and its scopes bind it instead
 * (operator decision; the routes give it the strictest scope that fits).
 * The check runs on the server for every request; the panel's dialog only
 * saves a round trip.
 */
export async function assertFreshStepUp(
  db: Database,
  caller: StepUpCaller,
  purpose: StepUpPurpose,
): Promise<void> {
  // First, and for API tokens too: an agent acting as a tenant carries
  // impersonatedBy as well.
  if (caller.impersonatedBy) {
    const [staff] = await db
      .select({ role: users.roleName, status: users.status })
      .from(users)
      .where(eq(users.id, caller.impersonatedBy))
      .limit(1);
    if (!staff || staff.status !== 'active' || !KEY_MATERIAL_IMPERSONATOR_ROLES.has(staff.role)) {
      // One fixed answer: it says nothing about the account's role or state.
      throw new ApiError(
        'IMPERSONATOR_ROLE_NOT_ALLOWED',
        'Under "Login as tenant" private keys are handed out only to super_admin and admin staff.',
        403,
        { purpose },
      );
    }
  }
  if (caller.apiToken) return;
  const status = await getStepUpStatus(db, caller, stepUpMaxAgeMs(purpose));
  if (!status.required) return;
  if (status.methods.length === 0) {
    throw new ApiError(
      'STEP_UP_UNAVAILABLE',
      status.impersonation
        ? 'Confirming it is you needs a password or a passkey on your own staff account, and it has neither. Register a passkey and turn on passkey sign-in under User settings in the admin panel, then try again.'
        : 'Confirming it is you needs a password or a passkey on your account, and yours has neither. Register a passkey and turn on passkey sign-in under User settings, then try again.',
      409,
      { reason: 'NO_STEP_UP_METHOD_AVAILABLE', purpose, impersonation: status.impersonation },
    );
  }
  throw new ApiError(
    'STEP_UP_REQUIRED',
    status.impersonation
      ? 'Confirm it is you, with your own staff password or passkey, before this is shown.'
      : 'Confirm it is you before this is shown.',
    403,
    {
      purpose,
      methods: status.methods,
      lastCredentialCheckAt: status.lastCredentialCheckAt?.toISOString() ?? null,
      maxAgeSeconds: Math.floor(status.maxAgeMs / 1000),
      impersonation: status.impersonation,
      credentialEmail: status.credentialEmail,
    },
    'POST /api/v1/me/step-up/{password|passkey/verify} with your active credential, then retry.',
  );
}

/**
 * Take one attempt from the holder's allowance — atomically, BEFORE the
 * password is checked, so parallel guesses serialise on the row lock and at
 * most STEP_UP_MAX_FAILED_PASSWORDS pass per window (the TOTP scheme,
 * totp-service.ts). The route's rate limit is per IP, because it runs before
 * the token is read; this is per person, whichever address they come from.
 */
async function reservePasswordAttempt(db: Database, userId: string, nowMs: number): Promise<boolean> {
  const now = new Date(nowMs);
  const windowFloor = new Date(nowMs - STEP_UP_FAILED_WINDOW_MS);
  const windowOver = sql`(${users.stepUpFailedWindowStartedAt} IS NULL OR ${users.stepUpFailedWindowStartedAt} < ${windowFloor})`;
  const rows = await db.update(users).set({
    stepUpFailedAttempts: sql`CASE WHEN ${windowOver} THEN 1 ELSE ${users.stepUpFailedAttempts} + 1 END`,
    stepUpFailedWindowStartedAt: sql`CASE WHEN ${windowOver} THEN ${now} ELSE ${users.stepUpFailedWindowStartedAt} END`,
  }).where(and(
    eq(users.id, userId),
    sql`(${windowOver} OR ${users.stepUpFailedAttempts} < ${STEP_UP_MAX_FAILED_PASSWORDS})`,
  )).returning({ id: users.id });
  return rows.length === 1;
}

async function lockedError(db: Database, userId: string, nowMs: number): Promise<ApiError> {
  const [row] = await db
    .select({ start: users.stepUpFailedWindowStartedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const windowStart = row?.start?.getTime() ?? nowMs;
  const retryAfter = Math.max(1, Math.ceil((windowStart + STEP_UP_FAILED_WINDOW_MS - nowMs) / 1000));
  return new ApiError('STEP_UP_LOCKED', 'Too many wrong passwords. Try again later.', 429, { retry_after: retryAfter });
}

/**
 * Verify a password as a step-up challenge for `userId` — the credential
 * holder (stepUpCredentialHolder). Does NOT issue session tokens and does not
 * record the step-up itself: the route records it for the calling session.
 *
 * Throws ApiError on bad credentials, and 429 STEP_UP_LOCKED once the holder
 * used up STEP_UP_MAX_FAILED_PASSWORDS in the window (a right password then
 * waits too). A right password gives back only the attempt it used itself:
 * the wrong ones stay counted until the window expires, so the owner stepping
 * up elsewhere cannot refresh a guesser's allowance. Mirror of
 * `verifyPassword` in auth/service.ts but scoped to step-up so we can keep
 * the rate-limit + audit semantics distinct.
 */
export async function verifyStepUpPassword(
  db: Database,
  userId: string,
  password: string,
  nowMs: number = Date.now(),
): Promise<void> {
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
  if (!(await reservePasswordAttempt(db, userId, nowMs))) throw await lockedError(db, userId, nowMs);
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    throw new ApiError('STEP_UP_FAILED', 'Step-up authentication failed', 401);
  }
  await db.update(users).set({
    lastCredentialCheckAt: new Date(nowMs),
    stepUpFailedAttempts: sql`GREATEST(${users.stepUpFailedAttempts} - 1, 0)`,
  }).where(eq(users.id, userId));
}

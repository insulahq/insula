/**
 * An archived tenant is closed to everyone who signed in to it: its panel
 * users, through every way in (password, passkey, OIDC, an admin's "Login as
 * tenant"), and sessions that were already open when it was archived.
 *
 * Access tokens are verified by signature alone and live 30 minutes, so ending
 * the refresh tokens is not enough on its own: `tenantClosedForSignIn` is asked
 * on every tenant-panel request (middleware/auth.ts). It caches the answer for
 * a few seconds — one indexed read per tenant per window, not per request.
 */
import { eq, inArray, and, isNull } from 'drizzle-orm';
import { refreshTokens, tenants, users } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { ApiError } from '../../shared/errors.js';

const CACHE_MS = 10_000;
const cache = new Map<string, { closed: boolean; at: number }>();

/** Test seam. */
export function resetTenantSignInCache(): void {
  cache.clear();
}

/**
 * Is `tenantId` archived? Cached for a few seconds. A tenant that is not there
 * is not "archived": a deleted tenant's users go with it, and its requests
 * fail on that.
 */
export async function tenantClosedForSignIn(
  db: Database,
  tenantId: string,
  opts: { readonly fresh?: boolean; readonly now?: number } = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const hit = cache.get(tenantId);
  if (!opts.fresh && hit && now - hit.at < CACHE_MS) return hit.closed;
  const [row] = await db.select({ status: tenants.status }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const closed = row?.status === 'archived';
  cache.set(tenantId, { closed, at: now });
  return closed;
}

/** The refusal every way in gives an archived tenant's users. */
export function tenantArchivedError(): ApiError {
  return new ApiError(
    'TENANT_ARCHIVED',
    'This account has been archived and can no longer be signed in to. Contact your hosting provider to restore it.',
    403,
  );
}

/** Refuse when `tenantId` is archived. For the sign-in paths: read fresh, they are rare. */
export async function assertTenantOpenForSignIn(db: Database, tenantId: string | null | undefined): Promise<void> {
  if (tenantId && await tenantClosedForSignIn(db, tenantId, { fresh: true })) throw tenantArchivedError();
}

/** End every refresh token of the tenant's users. Called when it is archived. */
export async function endTenantSessions(db: Database, tenantId: string): Promise<void> {
  cache.delete(tenantId);
  const ids = (await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId))).map((u) => u.id);
  if (ids.length === 0) return;
  await db.update(refreshTokens)
    .set({ revokedAt: new Date(), revokedReason: 'tenant_archived' })
    .where(and(inArray(refreshTokens.userId, ids), isNull(refreshTokens.revokedAt)));
}

/**
 * Impersonating a tenant: signing in as its admin user, on behalf of staff.
 *
 * Two callers, one rule set. The admin panel's "Impersonate" button
 * (`POST /admin/impersonate/:tenantId`, a signed-in person, a one-hour token
 * handed to the browser) and an AI agent's `asTenant` (executor.ts — an
 * in-process two-minute token that never leaves the server). The HTTP route
 * is closed to API tokens: a token holder must not be able to walk away with
 * a free-standing tenant credential that outlives its own revocation.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { users } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { ApiTokenClaim } from '../../shared/api-scope.js';
import { getTenantById } from './service.js';

export interface ImpersonationTarget {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
}

/** The tenant's active `tenant_admin`; 404 when the tenant or that user is missing. */
export async function findImpersonationTarget(db: Database, tenantId: string): Promise<ImpersonationTarget> {
  await getTenantById(db, tenantId);
  const [tenantUser] = await db
    .select({ id: users.id, email: users.email, fullName: users.fullName })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.roleName, 'tenant_admin'), eq(users.status, 'active')))
    .limit(1);
  if (!tenantUser) {
    throw new ApiError('NO_TENANT_USER', 'No active tenant_admin user found for this tenant', 404);
  }
  return tenantUser;
}

export function signImpersonationToken(
  app: FastifyInstance,
  input: {
    readonly target: ImpersonationTarget;
    readonly tenantId: string;
    readonly impersonatorId: string;
    readonly ttlSeconds: number;
    /** Set for an agent: the API token's scopes keep binding as the tenant. */
    readonly apiToken?: ApiTokenClaim;
  },
): string {
  const now = Math.floor(Date.now() / 1000);
  return app.jwt.sign({
    sub: input.target.id,
    role: 'tenant_admin',
    panel: 'tenant',
    tenantId: input.tenantId,
    impersonatedBy: input.impersonatorId,
    ...(input.apiToken ? { apiToken: input.apiToken } : {}),
    exp: now + input.ttlSeconds,
    iat: now,
    jti: crypto.randomUUID(),
  });
}

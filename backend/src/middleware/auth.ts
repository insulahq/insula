import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { insufficientPermissions, missingToken, invalidToken, ApiError } from '../shared/errors.js';

export type AdminRole = 'super_admin' | 'admin' | 'billing' | 'support' | 'read_only';
export type TenantRole = 'tenant_admin' | 'tenant_user';
export type AnyRole = AdminRole | TenantRole;

export interface JwtPayload {
  readonly sub: string;
  readonly role: AnyRole;
  readonly panel: 'admin' | 'tenant';
  readonly tenantId?: string;
  readonly impersonatedBy?: string;
  readonly exp: number;
  readonly iat: number;
  readonly jti?: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

// Route-level config flag for endpoints that authenticate via signed
// URL tokens (the GET handler verifies the token itself; the global
// auth/role hooks short-circuit when this flag is set). Augmenting
// FastifyContextConfig once removes the per-call cast that was
// previously copy-pasted into authenticate / requirePanel / requireRole.
declare module 'fastify' {
  interface FastifyContextConfig {
    skipAuth?: boolean;
  }
}

function shouldSkipAuth(request: FastifyRequest): boolean {
  return request.routeOptions?.config?.skipAuth === true;
}

export const PLATFORM_SESSION_COOKIE = 'platform_session';

export function registerAuth(_app: FastifyInstance): void {
  // @fastify/jwt already decorates request.user
}

export function extractPlatformSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (name !== PLATFORM_SESSION_COOKIE) continue;
    const value = pair.slice(eq + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/**
 * Bearer-only authentication. Use for all mutating endpoints and any
 * route that changes server state. Explicitly rejects cookie-bearing
 * requests so that SameSite=Lax + subdomain-hosted tenant content can't
 * CSRF state-changing API calls — the browser never auto-attaches a
 * Bearer header, so this middleware is safe by construction.
 */
export function authenticate(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: (err?: Error) => void,
): void {
  // Route-level opt-out for endpoints that authenticate via signed
  // URL tokens (no Bearer header survives a `window.location` GET).
  // The route is responsible for verifying its own token; setting
  // `config: { skipAuth: true }` exempts it from the global hook.
  if (shouldSkipAuth(request)) {
    done();
    return;
  }

  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    done(missingToken());
    return;
  }

  const token = authHeader.slice(7);

  // Phase 3: no denylist check. Access tokens are short-lived (30 min)
  // and verified statelessly via signature + exp. Revocation is via the
  // refresh-token side: a logout / password change kills future
  // /auth/refresh, and the access token expires within 30 min. For
  // immediate revocation of an active access token (admin disable),
  // see the admin-disable-user flow which sets users.status='disabled'
  // and is checked by /auth/refresh.
  try {
    const decoded = request.server.jwt.verify<JwtPayload>(token);
    request.user = decoded;
    done();
  } catch {
    done(invalidToken());
  }
}

export function requirePanel(panel: 'admin' | 'tenant') {
  return function checkPanel(
    request: FastifyRequest,
    _reply: FastifyReply,
    done: (err?: Error) => void,
  ): void {
    if (shouldSkipAuth(request)) {
      done();
      return;
    }
    if (!request.user || request.user.panel !== panel) {
      done(new ApiError(
        'PANEL_ACCESS_DENIED',
        `This endpoint requires ${panel} panel access`,
        403,
      ));
      return;
    }
    done();
  };
}

export function requireRole(...roles: AnyRole[]) {
  return function checkRole(
    request: FastifyRequest,
    _reply: FastifyReply,
    done: (err?: Error) => void,
  ): void {
    if (shouldSkipAuth(request)) {
      done();
      return;
    }
    if (!request.user || !roles.includes(request.user.role)) {
      done(insufficientPermissions(roles.join(', ')));
      return;
    }
    done();
  };
}

/**
 * Phase 6: shared method-aware role guard for tenant-resource
 * modules (domains, deployments, cron-jobs, ssh-keys, backups,
 * mailboxes, email-domains). GET/HEAD/OPTIONS are allowed for
 * read-only roles (including `tenant_user` and `read_only`),
 * but writes (POST/PATCH/PUT/DELETE) require `tenant_admin` or
 * staff (`super_admin`, `admin`, `support`).
 *
 * Before this helper existed, most modules installed a single
 * plugin-wide `requireRole('super_admin','admin','support',
 * 'tenant_admin','tenant_user')` hook which let a read-only
 * `tenant_user` token issue destructive requests — the UI just
 * happened to not expose the buttons in most places, but the
 * backend leaked write access.
 */
export function requireTenantRoleByMethod() {
  // Note: `read_only` is deliberately excluded from both lists
  // because it's an admin-panel aggregate-read role (dashboard,
  // metrics, health), not a tenant-resource read role. Adding it
  // here would be a permission expansion, not a preservation.
  const READ_ROLES: readonly AnyRole[] = [
    'super_admin', 'admin', 'support', 'tenant_admin', 'tenant_user',
  ];
  const WRITE_ROLES: readonly AnyRole[] = [
    'super_admin', 'admin', 'support', 'tenant_admin',
  ];
  return function checkTenantRoleByMethod(
    request: FastifyRequest,
    _reply: FastifyReply,
    done: (err?: Error) => void,
  ): void {
    const user = request.user;
    if (!user) {
      done(invalidToken());
      return;
    }
    const method = request.method.toUpperCase();
    const isWrite = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    const allowed = isWrite ? WRITE_ROLES : READ_ROLES;
    if (!allowed.includes(user.role)) {
      done(insufficientPermissions(allowed.join(', ')));
      return;
    }
    done();
  };
}

export function requireTenantAccess() {
  return function checkTenantAccess(
    request: FastifyRequest,
    _reply: FastifyReply,
    done: (err?: Error) => void,
  ): void {
    const user = request.user;
    if (!user) {
      done(invalidToken());
      return;
    }

    // Non-tenant-panel tokens (admin panel staff, service accounts
    // without a panel claim) can access any tenant — authorization
    // is already enforced by their preceding `requireRole(...)` hook.
    if (user.panel !== 'tenant') {
      done();
      return;
    }

    // Client panel users MUST have a tenantId claim on their token.
    // Phase 1 hardening: the previous version only rejected when
    // both `requestedTenantId` and `user.tenantId` were truthy, so
    // a misconfigured / hand-crafted tenant-panel token with no
    // tenantId claim could cross-tenant freely. Fail closed.
    if (!user.tenantId) {
      done(new ApiError(
        'CLIENT_ACCESS_DENIED',
        'Client-panel tokens must carry a tenantId claim',
        403,
      ));
      return;
    }

    // Client panel users can only access their own tenant
    const params = request.params as { tenantId?: string; id?: string };
    const requestedTenantId = params.tenantId ?? params.id;

    if (requestedTenantId && requestedTenantId !== user.tenantId) {
      done(new ApiError(
        'CLIENT_ACCESS_DENIED',
        'You can only access your own tenant resources',
        403,
      ));
      return;
    }

    done();
  };
}

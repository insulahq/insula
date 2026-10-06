import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { insufficientPermissions, missingToken, invalidToken, ApiError } from '../shared/errors.js';
import { enforceApiScope, type ApiTokenClaim } from '../shared/api-scope.js';
import { looksLikeToken, resolveToken } from '../modules/mcp/tokens.js';

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
  /**
   * Set ONLY on intermediate (non-session) tokens — currently the
   * `passkey_2fa` pre-auth token minted by /auth/login when the user
   * has opted into passkey second-factor. A payload carrying `step` is
   * NOT an access token; see assertAccessToken().
   */
  readonly step?: string;
  /**
   * Present when the request acts through an API token — a PAT used directly,
   * or an MCP tool call made with a PAT/OAuth token. Its scopes bind every
   * route (shared/api-scope.ts). Session requests never carry it.
   */
  readonly apiToken?: ApiTokenClaim;
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

/**
 * Reject any JWT that is not a full access token.
 *
 * /auth/login mints a short-lived PRE-AUTH token (`step: 'passkey_2fa'`)
 * when the user has passkey second-factor enabled: password succeeded,
 * passkey assertion still outstanding. It is signed with the same secret
 * as the access token, so `jwt.verify()` alone does NOT distinguish them —
 * the `step` claim is the only differentiator.
 *
 * SECURITY: this check previously lived only in
 * passkey-routes.ts and step-up-routes.ts. Every other consumer —
 * `authenticate()` and the four `request.jwtVerify()` handlers in
 * authRoutes — accepted a pre-auth token as a session token. Because
 * PATCH /auth/password hands back a real refresh token, an attacker who
 * knew the password could trade a pre-auth token for a full session and
 * skip the passkey entirely. Centralised here so a new route cannot
 * re-open the hole by forgetting to copy the check.
 *
 * Throws `invalidToken()` (401) — deliberately indistinguishable from a
 * bad signature so the caller learns nothing about token shape.
 */
export function assertAccessToken(payload: unknown): void {
  const step = (payload as { step?: unknown } | null | undefined)?.step;
  if (step !== undefined && step !== null && step !== '') {
    throw invalidToken();
  }
}

/**
 * `request.jwtVerify()` + access-token assertion, for the handful of
 * routes that verify inline instead of via the `authenticate` hook
 * (authRoutes has no plugin-level onRequest hook by design — /auth/login
 * and /auth/refresh must stay unauthenticated).
 */
export async function verifyAccessToken(request: FastifyRequest): Promise<void> {
  await request.jwtVerify();
  assertAccessToken(request.user);
}

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

  // An API token (PAT) instead of a session JWT: resolved against the DB
  // (cached briefly), acting as its owner with the token's scopes. OAuth
  // access tokens were issued FOR the MCP endpoint and are refused here.
  const tokenKind = looksLikeToken(token);
  if (tokenKind) {
    if (tokenKind !== 'pat') {
      done(invalidToken());
      return;
    }
    resolveToken(request.server.db, token).then((principal) => {
      if (!principal || principal.kind !== 'pat') {
        done(invalidToken());
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      request.user = {
        sub: principal.userId,
        role: principal.role as AnyRole,
        panel: 'admin',
        iat: now,
        exp: now + 60,
        apiToken: {
          tokenId: principal.tokenId, kind: 'pat', name: principal.name, scopes: principal.scopes, via: 'api',
        },
      };
      try {
        enforceApiScope(request);
      } catch (err) {
        done(err as Error);
        return;
      }
      done();
    }, () => done(invalidToken()));
    return;
  }

  // Phase 3: no denylist check. Access tokens are short-lived (30 min)
  // and verified statelessly via signature + exp. Revocation is via the
  // refresh-token side: a logout / password change kills future
  // /auth/refresh, and the access token expires within 30 min. For
  // immediate revocation of an active access token (admin disable),
  // see the admin-disable-user flow which sets users.status='disabled'
  // and is checked by /auth/refresh.
  let decoded: JwtPayload;
  try {
    decoded = request.server.jwt.verify<JwtPayload>(token);
    // A pre-auth (passkey_2fa) token is NOT a session token — reject it
    // here so every `authenticate`-guarded route is covered at once.
    assertAccessToken(decoded);
  } catch {
    done(invalidToken());
    return;
  }
  request.user = decoded;
  // An MCP tool call carries its token's scopes in the JWT it was minted
  // with; hold it to them like a PAT (no effect on session tokens).
  try {
    enforceApiScope(request);
  } catch (err) {
    done(err as Error);
    return;
  }
  done();
}

/** Guards carry what they allow, so the operation catalog can read it. */
export interface TaggedGuard {
  readonly allowedRoles?: readonly AnyRole[];
  readonly requiredPanel?: 'admin' | 'tenant';
}

export function requirePanel(panel: 'admin' | 'tenant') {
  return Object.assign(function checkPanel(
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
  }, { requiredPanel: panel } satisfies TaggedGuard);
}

export function requireRole(...roles: AnyRole[]) {
  return Object.assign(function checkRole(
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
  }, { allowedRoles: roles } satisfies TaggedGuard);
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

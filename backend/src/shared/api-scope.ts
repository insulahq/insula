/**
 * Token scopes on the REST API.
 *
 * A request made with an API token (a PAT, or an MCP tool call on behalf of
 * one) carries the token's scopes on `request.user.apiToken`. Every route is
 * classified as needing `read`, `write` or `delete`, and a request whose token
 * lacks that scope is refused with 403 INSUFFICIENT_SCOPE — on the route
 * itself, so an agent and an automation script are held to exactly the same
 * rule however they reach it.
 *
 * `delete` means "cannot be undone": removing, purging, or overwriting data
 * (a restore or import replaces what is there; rotating credentials breaks
 * whatever used the old ones). `write` is everything else that changes state.
 *
 * Classification, first match wins:
 *   1. `config.apiScope` on the route — a scope, or a function of the request
 *      for routes whose BODY decides (a file delete that is permanent, a
 *      status change that archives);
 *   2. GET/HEAD/OPTIONS → read;
 *   3. a path that names an irreversible action (delete, purge, restore,
 *      import, rollback, reset, regenerate, rotate, …) → `delete`, so a new
 *      route of that kind is strict before anyone thinks to annotate it;
 *   4. DELETE → delete, anything else → write.
 *
 * Sessions (a user signed in to the panel) carry no `apiToken` and are not
 * affected.
 */
import type { FastifyRequest } from 'fastify';
import type { McpScope } from '@insula/api-contracts';
import { ApiError } from './errors.js';

export type ApiScopeRule = McpScope | ((request: FastifyRequest) => McpScope);

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Scope an API token needs for this route (see shared/api-scope.ts). */
    apiScope?: ApiScopeRule;
    /**
     * Not callable with an API token at all — the reason is shown to the
     * caller. For routes that manage tokens or credentials themselves.
     */
    apiTokenForbidden?: string;
  }
}

/**
 * Path words that mean "this cannot be undone" (checked for non-GET methods
 * only), singular or plural — `/admin/restores/carts/:id/execute` is a restore
 * as much as `/restore-carts/:id/execute` is. A false match only asks for more
 * scope than needed; routes that are harmless despite their words say so with
 * `config.apiScope`.
 */
const DESTRUCTIVE_PATH = new RegExp(
  '(^|/|-)(delete|purge|wipe|destroy|drop|empty|erase|truncate|reset|restore|import|rollback|regenerate|rotate'
  + '|recover|decommission|prune|reclaim|force)s?(/|$|-)',
);

export function methodScope(method: string): McpScope {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return 'read';
  if (m === 'DELETE') return 'delete';
  return 'write';
}

/**
 * The scope a request needs, or 'pending' when a body-dependent rule cannot be
 * judged yet because the body has not been parsed (see enforceApiScope).
 */
export function requiredScope(
  method: string,
  routePath: string,
  rule: ApiScopeRule | undefined,
  request?: FastifyRequest,
  bodyReady = true,
): McpScope | 'pending' {
  if (typeof rule === 'string') return rule;
  if (typeof rule === 'function') return request && bodyReady ? rule(request) : 'pending';
  const byMethod = methodScope(method);
  if (byMethod === 'read') return 'read';
  if (DESTRUCTIVE_PATH.test(routePath)) return 'delete';
  return byMethod;
}

/**
 * One top-level field of the request body, for body-dependent scope rules.
 * Read-only and untyped on purpose: the route still validates the body itself.
 */
export function bodyField(request: FastifyRequest, field: string): unknown {
  const body = request.body;
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[field] : undefined;
}

/** What the token carries, when the request was made with one. */
export interface ApiTokenClaim {
  readonly tokenId: string;
  readonly kind: 'pat' | 'oauth';
  readonly name: string;
  readonly scopes: readonly McpScope[];
  /** 'api' = the token was used directly; 'mcp' = through an MCP tool. */
  readonly via: 'api' | 'mcp';
}

export function insufficientScope(needed: McpScope): ApiError {
  return new ApiError(
    'INSUFFICIENT_SCOPE',
    `This API token does not have the "${needed}" scope this action needs.`,
    403,
    { requiredScope: needed },
  );
}

/** True when a body has been parsed or none is coming. */
function bodySettled(request: FastifyRequest): boolean {
  if (request.body !== undefined) return true;
  const length = request.headers['content-length'];
  const chunked = request.headers['transfer-encoding'];
  return !chunked && (length === undefined || length === '0');
}

/**
 * Refuse the request when its API token lacks the scope the route needs.
 * No effect for session requests.
 *
 * Called twice: by `authenticate` (whatever hook it runs in) and by a global
 * preHandler (`stage: 'handler'`, body parsed). A body-dependent rule is
 * judged by whichever comes first with the body settled, so neither hook
 * order nor a body-less request can skip it.
 */
export function enforceApiScope(request: FastifyRequest, stage: 'auth' | 'handler' = 'auth'): void {
  const claim = (request.user as { apiToken?: ApiTokenClaim } | undefined)?.apiToken;
  if (!claim) return;
  const config = request.routeOptions?.config;
  if (config?.apiTokenForbidden) {
    throw new ApiError('API_TOKEN_NOT_ALLOWED', config.apiTokenForbidden, 403);
  }
  const bodyReady = stage === 'handler' || bodySettled(request);
  const needed = requiredScope(request.method, request.routeOptions?.url ?? request.url, config?.apiScope, request, bodyReady);
  if (needed === 'pending') return;
  if (!claim.scopes.includes(needed)) throw insufficientScope(needed);
}

/**
 * Run a catalog operation on behalf of an API token.
 *
 * The operation is the route itself: `app.inject` sends a real request through
 * the full Fastify pipeline — authentication, role guards, scope enforcement,
 * validation, rate limiting, audit — with a two-minute access JWT minted for
 * the token's owner that carries the token's scopes. Nothing here re-implements
 * a platform function, so an agent can do exactly what the API allows and no
 * more.
 *
 * Acting AS a tenant uses the platform's impersonation rules
 * (tenants/impersonation.ts) in-process: a two-minute tenant token that
 * inherits the API token's scopes and never leaves the server; the audit trail
 * records the admin behind every action taken with it.
 *
 * A TENANT agent (the tenant panel's MCP endpoint) is the tenant user who
 * approved it: its calls carry that user's own tenant-panel claims — role,
 * tenant — so every tenant guard applies exactly as in the panel. Its tenant
 * id is filled into the path for it; `asTenant` does not exist there.
 */
import type { FastifyInstance } from 'fastify';
import type { McpScope } from '@insula/api-contracts';
import { signAccessToken } from '../auth/access-token.js';
import { tenantAgentCredentialRefused } from '../../shared/api-scope.js';
import { API_PREFIX, type Operation } from './catalog.js';
import type { TokenPrincipal } from './tokens.js';
import { tenantParamOf } from './tools.js';
import { findImpersonationTarget, signImpersonationToken } from '../tenants/impersonation.js';

/** Largest response handed back to an agent before it is cut. */
export const MAX_RESULT_CHARS = 200_000;
const CALL_TOKEN_TTL_SECONDS = 120;

export interface OperationInput {
  readonly pathParams?: Record<string, string | number>;
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
  /** Run as this tenant (through impersonation) instead of as the admin. */
  readonly asTenant?: string;
}

export interface OperationResult {
  readonly status: number;
  readonly ok: boolean;
  /** Parsed JSON when the route answered JSON, else text. */
  readonly body: unknown;
  readonly truncated: boolean;
}

export class OperationInputError extends Error {}

export function buildPath(op: Operation, params: Record<string, string | number> = {}): string {
  return op.path.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
    const v = params[name];
    if (v === undefined || v === null || String(v) === '') {
      throw new OperationInputError(`missing path parameter "${name}" for ${op.key}`);
    }
    // encodeURIComponent leaves `.` alone, and the injected request's URL
    // would resolve a `..` segment into a different route.
    if (String(v) === '.' || String(v) === '..') {
      throw new OperationInputError(`path parameter "${name}" cannot be "${String(v)}"`);
    }
    return encodeURIComponent(String(v));
  });
}

export function buildQuery(query: Record<string, unknown> = {}): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
    else qs.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

function claimFor(principal: TokenPrincipal) {
  return {
    tokenId: principal.tokenId,
    kind: principal.kind,
    name: principal.name,
    scopes: [...principal.scopes] as McpScope[],
    via: 'mcp' as const,
    audience: principal.audience,
  };
}

function adminCallToken(app: FastifyInstance, principal: TokenPrincipal): string {
  return signAccessToken(app, { userId: principal.userId, role: principal.role, panel: 'admin' }, {
    ttlSeconds: CALL_TOKEN_TTL_SECONDS, via: 'mcp', apiToken: claimFor(principal),
  });
}

/** The tenant user's own tenant-panel claims, for a tenant agent's call. */
function tenantUserCallToken(app: FastifyInstance, principal: TokenPrincipal): string {
  return signAccessToken(app, {
    userId: principal.userId, role: principal.role, panel: 'tenant', tenantId: principal.tenantId,
  }, {
    ttlSeconds: CALL_TOKEN_TTL_SECONDS, via: 'mcp', apiToken: claimFor(principal),
  });
}

function parseBody(payload: string, contentType: string | undefined): { body: unknown; truncated: boolean } {
  const truncated = payload.length > MAX_RESULT_CHARS;
  const text = truncated ? payload.slice(0, MAX_RESULT_CHARS) : payload;
  if (!truncated && contentType?.includes('application/json')) {
    try {
      return { body: JSON.parse(text), truncated };
    } catch { /* fall through to text */ }
  }
  return { body: text, truncated };
}

async function injectAs(
  app: FastifyInstance, token: string, method: string, url: string, body: unknown, clientIp: string,
): Promise<OperationResult> {
  const hasBody = body !== undefined && method !== 'GET' && method !== 'HEAD';
  const res = await app.inject({
    method: method as 'GET',
    url,
    remoteAddress: clientIp,
    headers: {
      authorization: `Bearer ${token}`,
      'user-agent': 'insula-mcp',
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
    },
    ...(hasBody ? { payload: JSON.stringify(body) } : {}),
  });
  const parsed = parseBody(res.payload, String(res.headers['content-type'] ?? ''));
  return { status: res.statusCode, ok: res.statusCode < 400, body: parsed.body, truncated: parsed.truncated };
}

/**
 * A two-minute tenant token for `tenantId`, carrying the principal's scopes.
 * Minted in-process with the same rules as the panel's Impersonate button
 * (tenants/impersonation.ts) and never returned to the agent.
 */
async function tenantCallToken(app: FastifyInstance, principal: TokenPrincipal, tenantId: string): Promise<string> {
  try {
    const target = await findImpersonationTarget(app.db, tenantId);
    app.log.info({ tenantId, impersonatorId: principal.userId, apiTokenId: principal.tokenId }, 'mcp: acting as tenant');
    return signImpersonationToken(app, {
      target, tenantId, impersonatorId: principal.userId, ttlSeconds: CALL_TOKEN_TTL_SECONDS, apiToken: claimFor(principal),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new OperationInputError(`could not act as tenant ${tenantId}: ${msg}`);
  }
}

export async function executeOperation(
  app: FastifyInstance,
  principal: TokenPrincipal,
  op: Operation,
  input: OperationInput,
  clientIp: string,
): Promise<OperationResult> {
  if (op.excluded) throw new OperationInputError(`${op.key} is not available to agents: ${op.excluded}`);
  if (principal.audience === 'tenant') {
    if (!principal.tenantId) throw new OperationInputError('this connection is not bound to a tenant');
    if (input.asTenant) throw new OperationInputError('asTenant is not available here: this agent already acts in its own tenant');
    // Said here so the agent gets a reason, not a bare 403; the route refuses it too.
    if (op.issuesCredential) throw new OperationInputError(`${op.key} is not available to agents: ${tenantAgentCredentialRefused().message}`);
    // The tenant is the connection's, whatever the agent passed — a different
    // id would only be refused by the route's tenant guard anyway.
    const tenantParam = tenantParamOf(op);
    const pathParams = tenantParam ? { ...input.pathParams, [tenantParam]: principal.tenantId } : input.pathParams;
    const url = `${API_PREFIX}${buildPath(op, pathParams)}${buildQuery(input.query)}`;
    return injectAs(app, tenantUserCallToken(app, principal), op.method, url, input.body, clientIp);
  }
  const url = `${API_PREFIX}${buildPath(op, input.pathParams)}${buildQuery(input.query)}`;
  const token = input.asTenant
    ? await tenantCallToken(app, principal, input.asTenant)
    : adminCallToken(app, principal);
  return injectAs(app, token, op.method, url, input.body, clientIp);
}

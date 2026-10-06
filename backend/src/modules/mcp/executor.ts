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
 * Acting AS a tenant goes through the platform's own impersonation route
 * (`POST /admin/impersonate/:tenantId`): the tenant token it returns inherits
 * the API token's scopes, and the audit trail records the admin behind it.
 */
import type { FastifyInstance } from 'fastify';
import type { McpScope } from '@insula/api-contracts';
import { signAccessToken } from '../auth/access-token.js';
import { API_PREFIX, type Operation } from './catalog.js';
import type { TokenPrincipal } from './tokens.js';

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
  };
}

function adminCallToken(app: FastifyInstance, principal: TokenPrincipal): string {
  return signAccessToken(app, { userId: principal.userId, role: principal.role, panel: 'admin' }, {
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

/** An impersonation token for `tenantId`, carrying the principal's scopes. */
async function tenantCallToken(
  app: FastifyInstance, principal: TokenPrincipal, tenantId: string, clientIp: string,
): Promise<string> {
  const res = await injectAs(
    app, adminCallToken(app, principal), 'POST',
    `${API_PREFIX}/admin/impersonate/${encodeURIComponent(tenantId)}`, {}, clientIp,
  );
  const token = (res.body as { data?: { token?: unknown } } | null)?.data?.token;
  if (!res.ok || typeof token !== 'string') {
    const err = (res.body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
    throw new OperationInputError(`could not act as tenant ${tenantId}: ${err}`);
  }
  return token;
}

export async function executeOperation(
  app: FastifyInstance,
  principal: TokenPrincipal,
  op: Operation,
  input: OperationInput,
  clientIp: string,
): Promise<OperationResult> {
  if (op.excluded) throw new OperationInputError(`${op.key} is not available to agents: ${op.excluded}`);
  const url = `${API_PREFIX}${buildPath(op, input.pathParams)}${buildQuery(input.query)}`;
  const token = input.asTenant
    ? await tenantCallToken(app, principal, input.asTenant, clientIp)
    : adminCallToken(app, principal);
  return injectAs(app, token, op.method, url, input.body, clientIp);
}

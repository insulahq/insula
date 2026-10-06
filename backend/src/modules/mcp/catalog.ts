/**
 * The operation catalog: every REST route of the platform, as an agent sees it.
 *
 * Collected from Fastify's own route table (an `onRoute` hook registered before
 * any route), so it is not a second description of the API that could drift
 * from the first — it IS the API. An agent's tool call runs the route itself
 * (executor.ts), through the same guards, validation, audit and scope checks
 * as any other caller. A route added tomorrow is an operation tomorrow.
 *
 * A route is left out only for a stated reason (EXCLUSIONS, or
 * `config.apiTokenForbidden` on the route); `catalog.test.ts` keeps that list
 * honest.
 */
import type { FastifyInstance, RouteOptions } from 'fastify';
import { z } from 'zod';
import type { McpScope } from '@insula/api-contracts';
import { requiredScope, type ApiScopeRule } from '../../shared/api-scope.js';
import type { AnyRole, TaggedGuard } from '../../middleware/auth.js';

export const API_PREFIX = '/api/v1';

export interface Operation {
  /** "METHOD /path" without the /api/v1 prefix — the operation's name. */
  readonly key: string;
  readonly method: string;
  /** Route pattern without the prefix, e.g. `/admin/tenants/:id`. */
  readonly path: string;
  readonly summary: string | null;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly pathParams: readonly string[];
  /** JSON schemas declared on the route (or via `config.apiBody`). */
  readonly querySchema: Record<string, unknown> | null;
  readonly bodySchema: Record<string, unknown> | null;
  /** Roles the route's own guards allow; null when not declared at route level. */
  readonly allowedRoles: readonly AnyRole[] | null;
  /** Panel the route's own guards require, when declared at route level. */
  readonly panel: 'admin' | 'tenant' | null;
  /** The scope an API token needs; 'varies' when the body decides. */
  readonly scope: McpScope | 'varies';
  readonly scopeRule: ApiScopeRule | undefined;
  /** Set when agents may not call this route, with the reason. */
  readonly excluded: string | null;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Zod schema of the JSON body, for routes that validate inside the
     * handler. Describes the operation to agents; the route keeps validating
     * exactly as before.
     */
    apiBody?: z.ZodType;
    /** Same, for the query string. */
    apiQuery?: z.ZodType;
  }
}

/** Routes agents never call, by pattern, each with the reason shown to them. */
export const EXCLUSIONS: ReadonlyArray<{ readonly pattern: RegExp; readonly reason: string }> = [
  { pattern: /^\/auth(\/|$)/, reason: 'sign-in and credential flows belong to a person in a browser' },
  { pattern: /^\/oauth(\/|$)/, reason: 'agent authorization itself' },
  { pattern: /^\/mcp(\/|$)/, reason: 'the agent endpoint itself' },
  { pattern: /^\/admin\/mcp(\/|$)/, reason: 'agent and API-token access is managed by a signed-in person' },
  { pattern: /^\/internal(\/|$)/, reason: 'cluster-internal endpoint' },
  { pattern: /^\/healthz$/, reason: 'liveness probe' },
  { pattern: /\/node-terminal(\/|$)/, reason: 'interactive host shell (super_admin only)' },
  { pattern: /\/files\/(download|upload|upload-raw)$/, reason: 'binary stream — use the file read/write operations' },
  { pattern: /^\/preview\/[^/]+(\/|$)/, reason: 'proxies a live tenant site (authenticated by its preview link)' },
];

function flatHooks(hook: unknown): unknown[] {
  if (!hook) return [];
  return Array.isArray(hook) ? hook.flat(3) : [hook];
}

function guardTags(route: RouteOptions): { roles: AnyRole[] | null; panel: 'admin' | 'tenant' | null } {
  let roles: AnyRole[] | null = null;
  let panel: 'admin' | 'tenant' | null = null;
  for (const fn of [...flatHooks(route.onRequest), ...flatHooks(route.preHandler)]) {
    const tag = fn as TaggedGuard;
    if (tag?.allowedRoles) roles = [...tag.allowedRoles];
    if (tag?.requiredPanel) panel = tag.requiredPanel;
  }
  return { roles, panel };
}

function jsonSchema(source: unknown): Record<string, unknown> | null {
  if (!source || typeof source !== 'object') return null;
  if (source instanceof z.ZodType) {
    try {
      return z.toJSONSchema(source, { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return source as Record<string, unknown>;
}

function exclusionFor(path: string, route: RouteOptions): string | null {
  const config = (route.config ?? {}) as { skipAuth?: boolean; apiTokenForbidden?: string };
  if (config.apiTokenForbidden) return config.apiTokenForbidden;
  if (config.skipAuth) return 'authenticated by a signed URL, not a token';
  if ((route as { websocket?: boolean }).websocket) return 'interactive stream (WebSocket)';
  const hit = EXCLUSIONS.find((e) => e.pattern.test(path));
  return hit?.reason ?? null;
}

export function operationFromRoute(route: RouteOptions, method: string): Operation | null {
  const url = route.url;
  if (!url || !url.startsWith(`${API_PREFIX}/`)) return null;
  if (method === 'HEAD') return null; // Fastify's automatic twin of every GET
  const path = url.slice(API_PREFIX.length);
  const schema = (route.schema ?? {}) as {
    summary?: string; description?: string; tags?: string[]; querystring?: unknown; body?: unknown;
  };
  const config = (route.config ?? {}) as { apiScope?: ApiScopeRule; apiBody?: z.ZodType; apiQuery?: z.ZodType };
  const { roles, panel } = guardTags(route);
  const rule = config.apiScope;
  const scope = typeof rule === 'function' ? 'varies' : requiredScope(method, url, rule) as McpScope;
  return {
    key: `${method} ${path}`,
    method,
    path,
    summary: schema.summary ?? null,
    description: schema.description ?? null,
    tags: schema.tags ?? [],
    pathParams: [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]),
    querySchema: jsonSchema(config.apiQuery ?? schema.querystring),
    bodySchema: jsonSchema(config.apiBody ?? schema.body),
    allowedRoles: roles,
    panel,
    scope,
    scopeRule: rule,
    excluded: exclusionFor(path, route),
  };
}

export class OperationCatalog {
  private readonly ops = new Map<string, Operation>();

  add(op: Operation): void {
    this.ops.set(op.key, op);
  }

  get(key: string): Operation | undefined {
    return this.ops.get(normalizeKey(key));
  }

  all(): Operation[] {
    return [...this.ops.values()];
  }

  /** Operations an agent may call (not excluded). */
  callable(): Operation[] {
    return this.all().filter((o) => !o.excluded);
  }
}

/** Accept "get /admin/tenants" and "/api/v1"-prefixed paths as well. */
export function normalizeKey(key: string): string {
  const m = key.trim().match(/^([A-Za-z]+)\s+(\S+)$/);
  if (!m) return key.trim();
  const path = m[2].startsWith(API_PREFIX) ? m[2].slice(API_PREFIX.length) : m[2];
  return `${m[1].toUpperCase()} ${path}`;
}

/**
 * Attach the catalog to an app. Must run before any route is registered —
 * an `onRoute` hook only sees routes added after it.
 */
export function collectOperations(app: FastifyInstance): OperationCatalog {
  const catalog = new OperationCatalog();
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      const op = operationFromRoute(route, String(method).toUpperCase());
      if (op) catalog.add(op);
    }
  });
  return catalog;
}

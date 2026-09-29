/**
 * Traffic endpoints.
 *
 * Two surfaces over one service. The admin surface takes a scope and a subject
 * as given; the tenant surface takes the tenant from the PATH — where
 * `requireTenantAccess` has already authorised it — and overwrites whatever
 * scope and subject the client sent. A tenant cannot name another tenant's
 * namespace here, because nothing they send is used to choose one.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  TENANT_TRAFFIC_SCOPES, trafficSeriesQuerySchema, trafficSubjectsQuerySchema,
  type TrafficScope,
} from '@insula/api-contracts';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { tenants } from '../../db/schema.js';
import { fetchTrafficFrame, fetchTrafficSubjects } from './service.js';
import { isValidNamespace, UnsupportedTrafficQuery } from './promql.js';

/** Zod issues → one operator-readable 400, rather than a wall of JSON. */
function parseOrThrow<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success || !parsed.data) {
    const detail = (parsed.error?.issues ?? [])
      .map((i) => `${i.path.join('.') || 'query'}: ${i.message}`)
      .join('; ');
    throw new ApiError('INVALID_TRAFFIC_QUERY', detail || 'Invalid traffic query', 400);
  }
  return parsed.data;
}

async function namespaceOfTenant(app: FastifyInstance, tenantId: string): Promise<string> {
  const [row] = await app.db
    .select({ ns: tenants.kubernetesNamespace })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!row?.ns) {
    throw new ApiError('TENANT_NOT_PROVISIONED', 'This tenant has no namespace yet, so no traffic has been recorded.', 404);
  }
  return row.ns;
}

/** `UnsupportedTrafficQuery` is a 400 about the question, not a 500. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UnsupportedTrafficQuery) {
      throw new ApiError('TRAFFIC_QUERY_UNSUPPORTED', err.message, 400);
    }
    throw err;
  }
}

export async function trafficRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  // ── admin ────────────────────────────────────────────────────────────
  app.get('/admin/monitoring/traffic/series', {
    onRequest: [requireRole('super_admin', 'admin', 'billing', 'support', 'read_only')],
  }, async (request) => {
    const q = parseOrThrow(trafficSeriesQuerySchema, request.query);
    const subject = q.scope === 'tenant' || q.scope === 'pod'
      ? (q.subject ? await resolveNamespaceArg(app, q.subject) : undefined)
      : q.subject;
    return success(await guard(() => fetchTrafficFrame({
      from: new Date(q.from), to: new Date(q.to), scope: q.scope, subject, pod: q.pod,
      metric: q.metric, direction: q.direction, backups: q.backups,
    }, { db: app.db })));
  });

  app.get('/admin/monitoring/traffic/subjects', {
    onRequest: [requireRole('super_admin', 'admin', 'billing', 'support', 'read_only')],
  }, async (request) => {
    const q = parseOrThrow(trafficSubjectsQuerySchema, request.query);
    // Normalise for BOTH namespace-addressed scopes. `tenant` used to skip
    // this, so an unchecked string reached the service matcher.
    const subject = (q.scope === 'pod' || q.scope === 'tenant') && q.subject
      ? await resolveNamespaceArg(app, q.subject)
      : q.subject;
    const subjects = await guard(() => fetchTrafficSubjects({
      from: new Date(q.from), to: new Date(q.to), scope: q.scope, subject, metric: q.metric,
    }, { db: app.db }));
    return success({ subjects });
  });

  // ── tenant ───────────────────────────────────────────────────────────
  app.get('/tenants/:id/traffic/series', {
    onRequest: [
      requireRole('super_admin', 'admin', 'billing', 'support', 'tenant_admin', 'tenant_user'),
      requireTenantAccess(),
    ],
  }, async (request) => {
    const { id } = request.params as { id: string };
    const q = parseOrThrow(trafficSeriesQuerySchema, request.query);
    const scope = assertTenantScope(q.scope);
    const namespace = await namespaceOfTenant(app, id);
    return success(await guard(() => fetchTrafficFrame({
      from: new Date(q.from),
      to: new Date(q.to),
      scope,
      // A route is addressed by Traefik SERVICE, which is never equal to the
      // bare namespace — forcing the namespace in here selected nothing and
      // rendered an empty chart that read as "no traffic". Route scope is
      // confined by namespace instead, and a named route must belong to it.
      subject: scope === 'route' ? ownRouteOrNone(q.subject, namespace) : namespace,
      restrictToNamespace: namespace,
      pod: q.pod,
      metric: q.metric,
      direction: q.direction,
      // A platform-scheduled backup is excluded from this tenant's bill, so it
      // is not drawn on their graph either: the two must agree.
      backups: 'included',
    }, { db: app.db })));
  });

  app.get('/tenants/:id/traffic/subjects', {
    onRequest: [
      requireRole('super_admin', 'admin', 'billing', 'support', 'tenant_admin', 'tenant_user'),
      requireTenantAccess(),
    ],
  }, async (request) => {
    const { id } = request.params as { id: string };
    const q = parseOrThrow(trafficSubjectsQuerySchema, request.query);
    const scope = assertTenantScope(q.scope);
    const namespace = await namespaceOfTenant(app, id);
    const subjects = await guard(() => fetchTrafficSubjects({
      from: new Date(q.from),
      to: new Date(q.to),
      scope,
      // Leaving `subject` unset for route scope is what makes this a LIST:
      // with it set the frame is a single subject and the picker came back
      // empty, so a tenant could never choose one of their own routes.
      subject: scope === 'route' ? undefined : namespace,
      restrictToNamespace: namespace,
      metric: q.metric,
    }, { db: app.db }));
    return success({ subjects });
  });
}

/**
 * A route the caller actually owns, or nothing.
 *
 * Traefik service labels start with the owning namespace, so ownership is
 * checkable without a lookup. Anything else is dropped rather than rejected:
 * a stale bookmark pointing at a route that has since been renamed should
 * show the tenant all their routes, not an error.
 */
function ownRouteOrNone(subject: string | undefined, namespace: string): string | undefined {
  if (!subject) return undefined;
  return subject.startsWith(`${namespace}-`) ? subject : undefined;
}

function assertTenantScope(scope: TrafficScope): TrafficScope {
  if (!(TENANT_TRAFFIC_SCOPES as readonly TrafficScope[]).includes(scope)) {
    throw new ApiError(
      'TRAFFIC_SCOPE_FORBIDDEN',
      `Scope '${scope}' is not available here. Valid: ${TENANT_TRAFFIC_SCOPES.join(', ')}.`,
      403,
    );
  }
  return scope;
}

/**
 * Admin callers address a tenant by id; the queries address it by namespace.
 * A value that is already a namespace is passed through, so the endpoint is
 * usable with either.
 *
 * `startsWith('tenant-')` is a routing hint, NOT a validator — it says which
 * lookup to skip, and on its own would let any string through as long as it
 * began with those seven characters. The shape check is what actually bounds
 * the value before it reaches a query.
 */
async function resolveNamespaceArg(app: FastifyInstance, subject: string): Promise<string> {
  if (subject.startsWith('tenant-')) {
    if (!isValidNamespace(subject)) {
      throw new ApiError(
        'INVALID_TRAFFIC_QUERY',
        'subject must be a tenant id or a Kubernetes namespace name',
        400,
      );
    }
    return subject;
  }
  const [row] = await app.db
    .select({ ns: tenants.kubernetesNamespace })
    .from(tenants)
    .where(eq(tenants.id, subject));
  return row?.ns ?? subject;
}

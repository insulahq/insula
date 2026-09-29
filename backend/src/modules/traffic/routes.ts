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
import { UnsupportedTrafficQuery } from './promql.js';

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
    const subject = q.scope === 'pod' && q.subject ? await resolveNamespaceArg(app, q.subject) : q.subject;
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
      // Always this tenant's namespace — the client's `subject` is discarded.
      subject: namespace,
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
      from: new Date(q.from), to: new Date(q.to), scope, subject: namespace, metric: q.metric,
    }, { db: app.db }));
    return success({ subjects });
  });
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
 */
async function resolveNamespaceArg(app: FastifyInstance, subject: string): Promise<string> {
  if (subject.startsWith('tenant-')) return subject;
  const [row] = await app.db
    .select({ ns: tenants.kubernetesNamespace })
    .from(tenants)
    .where(eq(tenants.id, subject));
  return row?.ns ?? subject;
}

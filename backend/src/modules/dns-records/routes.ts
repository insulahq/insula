import { eq, and } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireTenantAccess, requireTenantRoleByMethod } from '../../middleware/auth.js';
import { domains } from '../../db/schema.js';
import { createDnsRecordSchema, updateDnsRecordSchema } from './schema.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

async function assertNotSecondaryDns(app: FastifyInstance, tenantId: string, domainId: string): Promise<void> {
  const [domain] = await app.db
    .select()
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.tenantId, tenantId)));

  if (domain?.dnsMode === 'secondary') {
    throw new ApiError('DNS_READONLY', 'Secondary DNS zones are read-only', 403);
  }
}

export async function dnsRecordRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  // Phase 6: method-aware role guard — read open, writes staff+tenant_admin only
  app.addHook('onRequest', requireTenantRoleByMethod());
  app.addHook('onRequest', requireTenantAccess());

  // GET /api/v1/tenants/:tenantId/domains/:domainId/dns-records
  app.get('/tenants/:tenantId/domains/:domainId/dns-records', async (request) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const records = await service.listDnsRecords(app.db, tenantId, domainId);
    return success(records);
  });

  // POST /api/v1/tenants/:tenantId/domains/:domainId/dns-records
  app.post('/tenants/:tenantId/domains/:domainId/dns-records', async (request, reply) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    await assertNotSecondaryDns(app, tenantId, domainId);
    const parsed = createDnsRecordSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const record = await service.createDnsRecord(app.db, tenantId, domainId, parsed.data);
    reply.status(201).send(success(record));
  });

  // PATCH /api/v1/tenants/:tenantId/domains/:domainId/dns-records/:recordId
  app.patch('/tenants/:tenantId/domains/:domainId/dns-records/:recordId', async (request) => {
    const { tenantId, domainId, recordId } = request.params as {
      tenantId: string; domainId: string; recordId: string;
    };
    await assertNotSecondaryDns(app, tenantId, domainId);
    const parsed = updateDnsRecordSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const updated = await service.updateDnsRecord(app.db, tenantId, domainId, recordId, parsed.data);
    return success(updated);
  });

  // DELETE /api/v1/tenants/:tenantId/domains/:domainId/dns-records/:recordId
  app.delete('/tenants/:tenantId/domains/:domainId/dns-records/:recordId', async (request, reply) => {
    const { tenantId, domainId, recordId } = request.params as {
      tenantId: string; domainId: string; recordId: string;
    };
    await assertNotSecondaryDns(app, tenantId, domainId);
    await service.deleteDnsRecord(app.db, tenantId, domainId, recordId);
    reply.status(204).send();
  });

  // POST /api/v1/tenants/:tenantId/domains/:domainId/dns-records/sync
  app.post('/tenants/:tenantId/domains/:domainId/dns-records/sync', async (request) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const records = await service.syncRecordsFromProvider(app.db, tenantId, domainId);
    return success(records);
  });

  // GET /api/v1/tenants/:tenantId/domains/:domainId/dns-records/diff
  app.get('/tenants/:tenantId/domains/:domainId/dns-records/diff', async (request) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const diff = await service.diffRecordsWithProvider(app.db, tenantId, domainId);
    return success(diff);
  });

  // POST /api/v1/tenants/:tenantId/domains/:domainId/dns-records/pull
  app.post('/tenants/:tenantId/domains/:domainId/dns-records/pull', async (request, reply) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const body = request.body as { type: string; name: string; value: string; ttl?: number; local_id?: string };

    if (body.local_id) {
      // Adopt the REMOTE value into the local row — local-only by definition.
      // This used to call updateDnsRecord(), which pushes back to the provider:
      // a pull would immediately re-publish what it had just read, and could
      // fail on a record the provider was already happy with.
      const updated = await service.updateDnsRecordLocalOnly(app.db, tenantId, domainId, body.local_id, {
        record_value: body.value,
        ttl: body.ttl,
      });
      return success(updated);
    } else {
      // Create new local record (without syncing to remote — it already exists there).
      //
      // `body.value` is the remote record's full wire content (`10 mail.example.test.`
      // for MX, `10 5 5060 sip.example.test.` for SRV). It is stored verbatim rather
      // than split into the priority/weight/port columns: wire-format.ts passes
      // already-formatted content straight through, so the row round-trips back to
      // the provider unchanged and the diff compares equal.
      const created = await service.createDnsRecordLocalOnly(app.db, tenantId, domainId, {
        record_type: body.type as 'A',
        record_name: body.name,
        record_value: body.value,
        ttl: body.ttl ?? 3600,
      });
      reply.status(201);
      return success(created);
    }
  });

  // POST /api/v1/tenants/:tenantId/domains/:domainId/dns-records/push
  app.post('/tenants/:tenantId/domains/:domainId/dns-records/push', async (request) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const body = request.body as {
      type: string; name: string; value: string; ttl?: number;
      priority?: number; weight?: number; port?: number;
    };

    const [domain] = await app.db.select().from(domains).where(eq(domains.id, domainId));
    if (!domain) throw new ApiError('DOMAIN_NOT_FOUND', 'Domain not found', 404);

    const outcome = await service.syncRecordToProviders(app.db, domain.domainName, 'create', {
      type: body.type, name: body.name, content: body.value, ttl: body.ttl ?? 3600,
      priority: body.priority, weight: body.weight, port: body.port,
    }, domainId);

    // This used to answer `{ message: 'Record pushed to DNS server' }`
    // unconditionally — including when the provider had just rejected the
    // record — which is why Push appeared to do nothing at all.
    if (outcome.status === 'failed') {
      throw new ApiError(
        'DNS_PUBLISH_FAILED',
        `The DNS server rejected this record: ${service.describeSyncFailure(outcome)}`,
        502,
        { recordType: body.type, recordName: body.name, errors: outcome.errors },
      );
    }
    if (outcome.status === 'skipped') {
      throw new ApiError(
        'DNS_NOT_AUTHORITATIVE',
        `Cannot push this record — ${outcome.reason}.`,
        409,
        { reason: outcome.reason },
      );
    }

    return success({ message: `Record published to ${outcome.servers} DNS server(s)` });
  });
}

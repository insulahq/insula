import type { FastifyInstance } from 'fastify';
import { createDnsServerSchema, updateDnsServerSchema, createDnsProviderGroupSchema, updateDnsProviderGroupSchema } from '@insula/api-contracts';
import { authenticate, requireRole } from '../../middleware/auth.js';
import * as service from './service.js';
import type { CreateDnsServerInput, CreateProviderGroupInput, UpdateProviderGroupInput } from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

const encryptionKey = (): string => {
  const k = process.env.PLATFORM_ENCRYPTION_KEY;
  if (k && k.length >= 32) return k;
  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') return '0'.repeat(64);
  throw new Error('PLATFORM_ENCRYPTION_KEY is required (dns-servers routes)');
};

export async function dnsServerRoutes(app: FastifyInstance): Promise<void> {

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // ─── DNS Servers ────────────────────────────────────────────────────────────

  // GET /api/v1/admin/dns-servers
  app.get('/admin/dns-servers', async () => {
    return success(await service.listDnsServers(app.db));
  });

  // POST /api/v1/admin/dns-servers
  app.post('/admin/dns-servers', async (request, reply) => {
    const parsed = createDnsServerSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('MISSING_REQUIRED_FIELD', parsed.error.issues
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '), 400);
    }
    const input = parsed.data;
    const server = await service.createDnsServer(app.db, input, encryptionKey());
    reply.status(201).send(success(server));
  });

  // PATCH /api/v1/admin/dns-servers/:id
  app.patch('/admin/dns-servers/:id', async (request) => {
    const { id } = request.params as { id: string };
    const parsed = updateDnsServerSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('INVALID_FIELD', parsed.error.issues
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '), 400);
    }
    const input = parsed.data;
    const updated = await service.updateDnsServer(app.db, id, input, encryptionKey());
    return success(updated);
  });

  // DELETE /api/v1/admin/dns-servers/:id
  app.delete('/admin/dns-servers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await service.deleteDnsServer(app.db, id);
    reply.status(204).send();
  });

  // POST /api/v1/admin/dns-servers/:id/test
  app.post('/admin/dns-servers/:id/test', async (request) => {
    const { id } = request.params as { id: string };
    const result = await service.testDnsServerConnection(app.db, id, encryptionKey());
    return success(result);
  });

  // GET /api/v1/admin/dns-servers/:id/zones
  app.get('/admin/dns-servers/:id/zones', async (request) => {
    const { id } = request.params as { id: string };
    const server = await service.getDnsServerById(app.db, id);
    const provider = service.getProviderForServer(server, encryptionKey());
    const zones = await provider.listZones();
    return success(zones);
  });

  // ─── DNS Provider Groups ──────────────────────────────────────────────────

  // GET /api/v1/admin/dns-provider-groups
  app.get('/admin/dns-provider-groups', async () => {
    return success(await service.listProviderGroups(app.db));
  });

  // POST /api/v1/admin/dns-provider-groups
  app.post('/admin/dns-provider-groups', async (request, reply) => {
    const parsed = createDnsProviderGroupSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('MISSING_REQUIRED_FIELD', parsed.error.issues
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '), 400);
    }
    const input = parsed.data;
    const group = await service.createProviderGroup(app.db, input);
    reply.status(201).send(success(group));
  });

  // PATCH /api/v1/admin/dns-provider-groups/:id
  app.patch('/admin/dns-provider-groups/:id', async (request) => {
    const { id } = request.params as { id: string };
    const parsed = updateDnsProviderGroupSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('INVALID_FIELD', parsed.error.issues
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '), 400);
    }
    const input = parsed.data;
    const updated = await service.updateProviderGroup(app.db, id, input);
    return success(updated);
  });

  // DELETE /api/v1/admin/dns-provider-groups/:id
  app.delete('/admin/dns-provider-groups/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await service.deleteProviderGroup(app.db, id);
    reply.status(204).send();
  });
}

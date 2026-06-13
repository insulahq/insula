/**
 * Plesk migration routes (R1 PR 1) — source registry + discovery.
 *
 * super_admin only: registering a source stores an SSH private key and
 * discovery reads (potentially) every mailbox/DB on the source box —
 * comparable sensitivity to the node-terminal and security-hardening
 * surfaces, which are also super_admin-gated.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import type { z } from 'zod';
import {
  createPleskSourceSchema,
  updatePleskSourceSchema,
  createPleskMigrationSchema,
} from '@insula/api-contracts';
import * as service from './service.js';
import { startDiscovery } from './discovery.js';
import * as migrations from './migrations.js';
import { startMigration } from './provision.js';
import { pleskDiscoveries } from '../../db/schema.js';

/** Build k8s clients for a provisioning Job, or undefined if unavailable. */
async function tryK8sClients() {
  try {
    const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
    return createK8sClients(process.env.KUBECONFIG_PATH);
  } catch {
    return undefined;
  }
}

function parseOr400<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ApiError('INVALID_FIELD_VALUE', `Validation error: ${first.message} (${first.path.join('.')})`, 400, { field: first.path.join('.') });
  }
  return parsed.data;
}

export async function pleskMigrationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin'));

  // ── Sources ──
  app.get('/admin/plesk/sources', async () => success(await service.listSources(app.db)));

  app.post('/admin/plesk/sources', async (request, reply) => {
    const input = parseOr400(createPleskSourceSchema, request.body);
    const actorId = request.user?.sub ?? null;
    const created = await service.createSource(app.db, input, actorId);
    reply.status(201).send(success(created));
  });

  app.patch('/admin/plesk/sources/:id', async (request) => {
    const { id } = request.params as { id: string };
    const input = parseOr400(updatePleskSourceSchema, request.body);
    return success(await service.updateSource(app.db, id, input));
  });

  app.delete('/admin/plesk/sources/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await service.deleteSource(app.db, id);
    reply.status(204).send();
  });

  // ── Discovery ──
  app.post('/admin/plesk/sources/:id/discover', async (request, reply) => {
    const { id } = request.params as { id: string };
    await service.getSourceRow(app.db, id); // 404 if missing
    // One in-flight discovery per source — a second concurrent request
    // would spawn a duplicate Job and orphan a row.
    if (await service.hasActiveDiscovery(app.db, id)) {
      throw new ApiError('DISCOVERY_ALREADY_RUNNING', 'A discovery is already in progress for this source', 409);
    }
    const discoveryId = randomUUID();
    await app.db.insert(pleskDiscoveries).values({ id: discoveryId, sourceId: id, status: 'pending' });

    const k8s = await tryK8sClients();
    await startDiscovery(app.db, k8s, id, discoveryId, app.log);

    reply.status(202).send(success({ discoveryId, status: 'pending' }));
  });

  app.get('/admin/plesk/sources/:id/discoveries', async (request) => {
    const { id } = request.params as { id: string };
    await service.getSourceRow(app.db, id); // 404 if missing
    const rows = await service.listDiscoveries(app.db, id);
    return success(rows.map((r) => ({
      id: r.id, sourceId: r.sourceId, status: r.status,
      startedAt: r.startedAt, completedAt: r.completedAt,
      inventory: r.inventory ?? null, error: r.error ?? null,
    })));
  });

  app.get('/admin/plesk/discoveries/:discoveryId', async (request) => {
    const { discoveryId } = request.params as { discoveryId: string };
    const r = await service.getDiscovery(app.db, discoveryId);
    return success({
      id: r.id, sourceId: r.sourceId, status: r.status,
      startedAt: r.startedAt, completedAt: r.completedAt,
      inventory: r.inventory ?? null, error: r.error ?? null,
    });
  });

  // ── Migrations (provision a discovered subscription) ──
  app.post('/admin/plesk/migrations', async (request, reply) => {
    const input = parseOr400(createPleskMigrationSchema, request.body);
    const { id } = await migrations.createMigration(app.db, input, request.user?.sub ?? null);
    const k8s = await tryK8sClients();
    await startMigration(app.db, k8s, id, app.log);
    const row = await migrations.getMigration(app.db, id);
    reply.status(202).send(success(migrations.toMigrationResponse(row)));
  });

  app.get('/admin/plesk/migrations', async (request) => {
    const { sourceId } = request.query as { sourceId?: string };
    const rows = await migrations.listMigrations(app.db, sourceId);
    return success(rows.map(migrations.toMigrationResponse));
  });

  app.get('/admin/plesk/migrations/:id', async (request) => {
    const { id } = request.params as { id: string };
    const row = await migrations.getMigration(app.db, id);
    return success(migrations.toMigrationResponse(row));
  });

  // Re-run an idempotent provisioning pass on the SAME row (resume after
  // a failure / backend restart). The claim is atomic: only the request
  // that flips the row out of its terminal state spawns a runner, so two
  // concurrent Retry clicks can't race on the legs jsonb.
  app.post('/admin/plesk/migrations/:id/retry', async (request, reply) => {
    const { id } = request.params as { id: string };
    await migrations.getMigration(app.db, id); // 404 if missing
    const claimed = await migrations.claimMigrationForRetry(app.db, id);
    if (!claimed) {
      throw new ApiError('MIGRATION_ALREADY_RUNNING', 'This migration is already in progress', 409);
    }
    const k8s = await tryK8sClients();
    await startMigration(app.db, k8s, id, app.log);
    const fresh = await migrations.getMigration(app.db, id);
    reply.status(202).send(success(migrations.toMigrationResponse(fresh)));
  });
}

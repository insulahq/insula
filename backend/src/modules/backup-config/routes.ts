import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import {
  createBackupConfigSchema,
  updateBackupConfigSchema,
  markBackupTargetWritableSchema,
  type CreateBackupConfigInput,
} from '@insula/api-contracts';
import { markBackupTargetWritable } from './mark-writable.js';
import type { ZodError } from 'zod';
import { z } from 'zod';
import { createK8sClients, type K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { LonghornTenants } from './target-secret-shape.js';

// Turn a Zod issue list into a single human-readable message that's safe
// to surface to an operator via the admin panel. We preserve the field
// path (e.g. "s3_bucket") so the frontend can highlight the specific
// input that failed — response.ts envelope puts the string in `error`.
function zodMessage(err: ZodError): string {
  return err.issues
    .map((i) => {
      const path = i.path.length > 0 ? `${i.path.join('.')}: ` : '';
      return `${path}${i.message}`;
    })
    .join('; ');
}

export async function backupConfigRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey = app.config?.PLATFORM_ENCRYPTION_KEY ?? process.env.PLATFORM_ENCRYPTION_KEY ?? '0'.repeat(64) /* Dev-only fallback — production requires PLATFORM_ENCRYPTION_KEY env var */;

  // K8s tenant for the Longhorn reconciler. Created once at plugin
  // registration; pattern mirrors webmail-settings/routes.ts. Undefined
  // means the in-cluster config isn't loadable (e.g. vitest runs with
  // no kubeconfig) — handlers that need it return 502 from the
  // try/catch below rather than silently no-op-ing, which was the
  // original bug where `app.k8sTenants` was never decorated and the
  // Longhorn reconciler was always skipped.
  let k8s: K8sClients | undefined;
  try {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    k8s = createK8sClients(kubeconfigPath);
  } catch (err) {
    app.log.warn({ err }, 'backup-config: k8s tenant unavailable — reconciler disabled');
    k8s = undefined;
  }
  const longhornTenants: LonghornTenants | undefined = k8s
    ? { core: k8s.core, custom: k8s.custom, batch: k8s.batch }
    : undefined;

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/backup-configs
  app.get('/admin/backup-configs', async () => {
    return success(await service.listBackupConfigs(app.db));
  });

  // POST /api/v1/admin/backup-configs
  app.post('/admin/backup-configs', async (request, reply) => {
    const parsed = createBackupConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const config = await service.createBackupConfig(app.db, parsed.data, encryptionKey);
    reply.status(201).send(success(config));
  });

  // POST /api/v1/admin/backup-configs/test-draft — test BEFORE save.
  //
  // Accepts the same payload shape as POST create but never persists
  // anything. Enables the "Test Connection" button inside the create/
  // edit form so operators don't commit a config that can't talk to S3.
  // NOTE: this route is declared BEFORE the `:id/test` route so Fastify
  // doesn't try to interpret "test-draft" as an id path parameter.
  app.post('/admin/backup-configs/test-draft', async (request) => {
    const parsed = createBackupConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const result = await service.testDraft(parsed.data as CreateBackupConfigInput);
    return success(result);
  });

  // PATCH /api/v1/admin/backup-configs/:id
  app.patch('/admin/backup-configs/:id', async (request) => {
    const { id } = request.params as { id: string };
    const parsed = updateBackupConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const updated = await service.updateBackupConfig(app.db, id, parsed.data, encryptionKey);
    // Legacy target-activate retirement (2026-08-26): no Longhorn
    // reconcile leg — the 3-class shim assignments are the only backup
    // routing, and credential changes reach the shim via its own
    // inputHash-driven reconciler.
    return success(updated);
  });

  // DELETE /api/v1/admin/backup-configs/:id
  app.delete('/admin/backup-configs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await service.deleteBackupConfig(app.db, id);
    reply.status(204).send();
  });

  // POST /api/v1/admin/backup-configs/:id/test
  app.post('/admin/backup-configs/:id/test', async (request) => {
    const { id } = request.params as { id: string };
    const result = await service.testConnection(app.db, id, encryptionKey);
    return success(result);
  });

  // POST /api/v1/admin/backup-configs/:id/mark-writable — DR safety:
  // operator-confirmed flip from read_only=true to read_only=false.
  // Requires {confirmation: targetName, acknowledgeIntegrity: true}
  // in the body. Also re-attaches CNPG WAL archiving for every cluster
  // routing through this target. super_admin only.
  app.post('/admin/backup-configs/:id/mark-writable', {
    onRequest: [requireRole('super_admin')],
  }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = markBackupTargetWritableSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const u = request.user as { sub?: string; id?: string; jti?: string } | undefined;
    const userId = u?.sub ?? u?.id ?? null;
    if (!userId) {
      throw new ApiError('AUTHENTICATION_REQUIRED', 'Mark-writable requires an authenticated user', 401);
    }
    const operatorIp = (request.ip as string | undefined) ?? null;
    // Forensic capture for the compromised-admin threat model: jti
    // distinguishes captured-token replays from legitimate browser
    // sessions sharing an IP; UA distinguishes sessions sharing both.
    const operatorJti = u?.jti ?? null;
    const operatorUserAgent = (request.headers['user-agent'] as string | undefined) ?? null;
    const result = await markBackupTargetWritable({
      db: app.db,
      k8s,
      targetId: id,
      confirmation: parsed.data.confirmation,
      operatorUserId: userId,
      operatorIp,
      operatorJti,
      operatorUserAgent,
    });
    return success(result);
  });

  // Phase 10: POST /api/v1/admin/backup-configs/:id/speedtest
  //
  // Spawns an rclone Job that uploads a random payload (default 100 MB),
  // downloads it back, deletes the remote, and emits a parseable
  // SPEEDTEST_RESULT line. Result is persisted to backup_configurations
  // for the BackupSettings UI tile. Surfaces in task-center as
  // kind='backup.speedtest' with the 4-stage progress modal.
  const speedtestSchema = z.object({
    payloadBytes: z.number().int().min(1_048_576).max(1_073_741_824).optional(),
  });
  app.post('/admin/backup-configs/:id/speedtest', async (request) => {
    if (!k8s) {
      throw new ApiError('K8S_UNAVAILABLE', 'Cluster API not reachable — speedtest requires Job creation', 502);
    }
    const { id } = request.params as { id: string };
    const parsed = speedtestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0].message, 400);
    }
    // JWT payload uses `sub` (RFC 7519 + middleware/auth.ts). Task-center
    // refuses scope=admin with null user_id, so reject early with a clear
    // 401 if the bearer is absent/malformed.
    const u = request.user as { sub?: string; id?: string } | undefined;
    const userId = u?.sub ?? u?.id ?? null;
    if (!userId) {
      throw new ApiError('AUTHENTICATION_REQUIRED', 'Speedtest requires an authenticated user', 401);
    }
    const { runSpeedtest } = await import('./speedtest.js');
    const result = await runSpeedtest(app.db, k8s, {
      targetId: id,
      payloadBytes: parsed.data.payloadBytes,
      triggeredByUserId: userId,
    });
    return success(result);
  });

  // Legacy target-activate routes retired 2026-08-26 (operator
  // decision): POST /:id/activate, POST /:id/deactivate,
  // GET /:id/backups (Longhorn backup list) and POST /:id/backup-now
  // (Longhorn volume trigger) are gone. Backup routing is the 3-class
  // shim assignments; Longhorn volume-level backups no longer exist
  // (base RecurringJobs removed the same day).

  // GET /api/v1/admin/backup-health — discovery-driven roll-up of
  // every Job carrying the backup-health-watch=true label. Used by
  // the admin Backups page banner + DR Job Health table.
  app.get('/admin/backup-health', async () => {
    if (!longhornTenants?.batch) {
      throw new ApiError('K8S_UNAVAILABLE', 'K8s tenant unavailable', 502);
    }
    const { listHealthWatchedJobs, summariseHealth } = await import(
      '../backup-health/service.js'
    );
    const jobs = await listHealthWatchedJobs(longhornTenants.batch);
    const summary = summariseHealth(jobs);
    return success(summary);
  });

}

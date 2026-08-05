import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { updateSettingsSchema } from './schema.js';
import * as service from './service.js';
import { runVersionPoll, readPinnedPublicKey } from './poller/index.js';
import { getImageInventory } from './image-inventory.js';
import { getStorageInventory } from './storage-inventory.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function platformUpdateRoutes(app: FastifyInstance): Promise<void> {
  // All platform-update routes require admin auth
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/platform/version
  app.get('/admin/platform/version', {
    schema: {
      tags: ['Platform Updates'],
      summary: 'Get current platform version and update availability',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                installed: { type: 'string' },
                running: { type: 'string' },
                available: { type: 'string', nullable: true },
                currentVersion: { type: 'string' },
                latestVersion: { type: 'string', nullable: true },
                latestSource: { type: 'string', enum: ['releases', 'tags', 'none', 'unreachable'] },
                updateAvailable: { type: 'boolean' },
                environment: { type: 'string' },
                autoUpdate: { type: 'boolean' },
                imageUpdateStrategy: { type: 'string', enum: ['auto', 'manual'] },
                pendingVersion: { type: 'string', nullable: true },
                lastCheckedAt: { type: 'string', nullable: true },
                availableVerifiedAt: { type: 'string', nullable: true },
                availableVerifyStatus: { type: 'string', nullable: true },
                includePrereleases: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
  }, async () => {
    const info = await service.getVersionInfo(app.db);
    return success(info);
  });

  // POST /api/v1/admin/platform/version/check
  //
  // Poll GitHub NOW rather than reading what the hourly CronJob last wrote.
  //
  // The panel's "Check for updates" button used to call refetch() on the GET
  // above, which only re-reads platform_settings.available_version. With a 60s
  // staleTime on the query, repeated clicks did not even reach the network — so
  // after a release was published the operator could click "Check for updates"
  // indefinitely and still be told they were up to date, until the CronJob's
  // next hourly tick. Reported 2026-08-03, ~90 seconds after v2026.8.2 was
  // published: the 23:42 poll ran before the release existed and the next was
  // an hour out.
  //
  // Runs the SAME verified path as the CronJob (runVersionPoll → signature
  // check against the pinned key), so an on-demand check cannot accept anything
  // the scheduled one would refuse. A poll failure is not an error for the
  // caller: the response is always the current version info, so a GitHub outage
  // degrades to "no change" instead of a red panel.
  app.post('/admin/platform/version/check', {
    schema: {
      tags: ['Platform Updates'],
      summary: 'Check GitHub for a newer release now (verified, same path as the hourly poller)',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    try {
      const publicKeyPem = readPinnedPublicKey(process.env);
      const result = await runVersionPoll({
        db: app.db,
        env: process.env,
        publicKeyPem,
        log: (level, msg) => app.log[level]({ source: 'version-check' }, msg),
      });
      app.log.info({ status: result.status, available: result.availableVersion }, 'on-demand version check complete');
    } catch (err) {
      // Unreadable key / network / GitHub outage — report what we already know.
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'on-demand version check failed — returning last known version info',
      );
    }
    return success(await service.getVersionInfo(app.db));
  });

  // PUT /api/v1/admin/platform/update-settings
  app.put('/admin/platform/update-settings', {
    schema: {
      tags: ['Platform Updates'],
      summary: 'Update auto-update preference',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['autoUpdate'],
        properties: {
          autoUpdate: { type: 'boolean' },
          includePrereleases: { type: 'boolean' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                autoUpdate: { type: 'boolean' },
                includePrereleases: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
  }, async (request) => {
    const parsed = updateSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'VALIDATION_ERROR',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }
    const result = await service.updateSettings(app.db, parsed.data.autoUpdate, parsed.data.includePrereleases);
    return success(result);
  });

  // GET /api/v1/admin/platform/images — enumerate platform-owned images
  app.get('/admin/platform/images', {
    schema: {
      tags: ['Platform Updates'],
      summary: 'List container images currently running on the cluster for platform components',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const inventory = await getImageInventory();
    return success(inventory);
  });

  // GET /api/v1/admin/platform/storage — Longhorn node/volume summary
  app.get('/admin/platform/storage', {
    schema: {
      tags: ['Platform Updates'],
      summary: 'Longhorn node + volume + backup-target summary for the Storage Configuration card',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    // Pass app.db so the orphan classifier can attribute namespaces to
    // platform tenants. Without it the orphaned tile reports 0/0 even
    // when orphans exist.
    const inventory = await getStorageInventory(app.db);
    return success(inventory);
  });

  // POST /api/v1/admin/platform/capacity-check
  app.post('/admin/platform/capacity-check', {
    schema: {
      tags: ['Platform Updates'],
      summary: 'Check if the cluster has enough resources for an application',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['cpu', 'memory', 'storage'],
        properties: {
          cpu: { type: 'string' },
          memory: { type: 'string' },
          storage: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                totalCpu: { type: 'number' },
                totalMemory: { type: 'number' },
                totalStorage: { type: 'number' },
                allocatedCpu: { type: 'number' },
                allocatedMemory: { type: 'number' },
                allocatedStorage: { type: 'number' },
                requestedCpu: { type: 'number' },
                requestedMemory: { type: 'number' },
                requestedStorage: { type: 'number' },
                fits: { type: 'boolean' },
                warnings: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  }, async (request) => {
    const { cpu, memory, storage } = request.body as { cpu: string; memory: string; storage: string };
    const result = await service.getCapacityCheck(app.db, cpu, memory, storage);
    return success(result);
  });

  // NOTE: the old push-model `POST /admin/platform/update` (service.triggerUpdate
  // + the platform-update-checker CronJob → `flux reconcile`) was removed
  // 2026-07-28. It never re-pinned the tag, so it was a no-op on the production
  // pull model (tag-pinned GitRepository). The real upgrade path is
  // `POST /admin/platform/upgrade` (ADR-045 re-pin) in platform-upgrades/routes.ts.
}

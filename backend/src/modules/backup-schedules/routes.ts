import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import {
  updateBackupScheduleSchema,
  backupScheduleSubsystemEnum,
} from '@k8s-hosting/api-contracts';
import * as service from './service.js';

function actorIdOf(req: FastifyRequest): string | null {
  const u = req.user as { sub?: string; id?: string } | undefined;
  return u?.sub ?? u?.id ?? null;
}

export async function backupSchedulesRoutes(app: FastifyInstance): Promise<void> {
  const adminGate = [authenticate, requireRole('super_admin', 'admin')];

  app.get('/admin/backups/schedules', {
    onRequest: adminGate,
    schema: {
      tags: ['Backup Schedules'],
      summary: 'List every backup schedule with its gate state',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const schedules = await service.listSchedules(app.db);
    return success({ schedules });
  });

  app.get('/admin/backups/schedules/:subsystem', {
    onRequest: adminGate,
    schema: {
      tags: ['Backup Schedules'],
      summary: 'Read one backup schedule',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { subsystem } = request.params as { subsystem: string };
    const row = await service.getSchedule(app.db, subsystem);
    if (!row) {
      throw new ApiError(
        'SUBSYSTEM_NOT_FOUND',
        `No schedule for subsystem '${subsystem}'`,
        404,
      );
    }
    return success(row);
  });

  app.patch('/admin/backups/schedules/:subsystem', {
    onRequest: adminGate,
    schema: {
      tags: ['Backup Schedules'],
      summary: 'Update enable / cron / retention. Strict-gates enable=true.',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { subsystem } = request.params as { subsystem: string };
    // Allow any free-form subsystem string per migration 0011 (so new
    // subsystems land without a contract bump), but reject obvious
    // garbage. The enum guard surfaces unknown subsystems as a 400.
    if (!backupScheduleSubsystemEnum.options.includes(subsystem as never)) {
      throw new ApiError(
        'UNKNOWN_SUBSYSTEM',
        `Subsystem '${subsystem}' is not in the known enum: ${backupScheduleSubsystemEnum.options.join(', ')}`,
        400,
      );
    }
    const parsed = updateBackupScheduleSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0].message, 400);
    }
    const row = await service.updateSchedule(app.db, subsystem, parsed.data, actorIdOf(request));

    // 2026-05-27: for mail subsystem, propagate retention to the actual
    // restic forget command via the stalwart-snapshot CronJob env. Pre-fix
    // operator-set retention in this DB row had ZERO effect — snapshot-
    // upload.sh hardcoded --keep-last 48. Inline patch ensures the change
    // takes effect on the NEXT snapshot fire (~2 min worst case).
    if (subsystem === 'mail') {
      try {
        const { applyMailSnapshotRetention } = await import('../mail-admin/snapshot-settings.js');
        const cfg = app.config as Record<string, unknown>;
        const r = await applyMailSnapshotRetention(app.db, {
          kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
        });
        app.log.info(
          { retentionDays: r.retentionDays, retentionCount: r.retentionCount, patched: r.patched },
          'backup-schedules: propagated mail retention to stalwart-snapshot CronJob env',
        );
      } catch (err) {
        // Don't fail the DB write — operator's intent is persisted. Log
        // loudly so the operator sees if K8s patching failed.
        app.log.warn(
          { err, subsystem },
          'backup-schedules: mail retention DB write succeeded but K8s CronJob patch failed — retention in DB but NOT yet applied to next snapshot. Re-run the update OR wait for platform-api startup reconciler to catch up.',
        );
      }
    }

    return success(row);
  });
}

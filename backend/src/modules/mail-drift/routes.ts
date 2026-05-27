/**
 * Mail drift routes — operator-facing surface for the platform_db /
 * Stalwart drift items detected by the principals-sync reconciler.
 *
 * Mounted from app.ts via registerMailDriftRoutes(app). All routes
 * require super_admin (these are destructive operations that recreate
 * Stalwart entries and may generate new DKIM keys).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  mailDriftRecreateRequestSchema,
  type MailDriftListResponse,
  type MailDriftDismissResponse,
  type MailDriftRecreateResponse,
} from '@k8s-hosting/api-contracts';
import { requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import {
  listDriftItems,
  dismissDriftItem,
  recreateDriftItemEmpty,
} from './service.js';

const idParamSchema = z.object({ id: z.string().uuid() });

export async function registerMailDriftRoutes(app: FastifyInstance): Promise<void> {
  // GET /admin/mail/drift — list all drift items (active + recent history).
  app.get(
    '/admin/mail/drift',
    { preHandler: requireRole('super_admin') },
    async (): Promise<{ data: MailDriftListResponse }> => {
      const result = await listDriftItems(app.db);
      return success(result);
    },
  );

  // POST /admin/mail/drift/:id/dismiss — accepted loss, no further action.
  app.post(
    '/admin/mail/drift/:id/dismiss',
    { preHandler: requireRole('super_admin') },
    async (req): Promise<{ data: MailDriftDismissResponse }> => {
      const parsed = idParamSchema.safeParse(req.params);
      if (!parsed.success) {
        throw new ApiError('VALIDATION_ERROR', `Invalid drift item id: ${parsed.error.message}`, 400);
      }
      const item = await dismissDriftItem(app.db, parsed.data.id);
      return success({ item });
    },
  );

  // POST /admin/mail/drift/:id/recreate-empty — DESTRUCTIVE. Type-to-confirm
  //   guarded server-side via { confirmName }. Operator's frontend MUST
  //   also enforce type-to-confirm before calling (the server check is a
  //   backstop, not the primary UX).
  app.post(
    '/admin/mail/drift/:id/recreate-empty',
    { preHandler: requireRole('super_admin') },
    async (req): Promise<{ data: MailDriftRecreateResponse }> => {
      const parsedParams = idParamSchema.safeParse(req.params);
      if (!parsedParams.success) {
        throw new ApiError('VALIDATION_ERROR', `Invalid drift item id: ${parsedParams.error.message}`, 400);
      }
      const parsedBody = mailDriftRecreateRequestSchema.safeParse(req.body);
      if (!parsedBody.success) {
        throw new ApiError('VALIDATION_ERROR', `Invalid recreate request: ${parsedBody.error.message}`, 400);
      }
      const userId = (req as { user?: { sub?: string } }).user?.sub ?? 'unknown';
      app.log.warn(
        { userId, driftItemId: parsedParams.data.id, confirmName: parsedBody.data.confirmName },
        'mail-drift: operator-triggered RECREATE EMPTY (destructive)',
      );
      const result = await recreateDriftItemEmpty(
        app.db,
        parsedParams.data.id,
        parsedBody.data.confirmName,
      );
      return success(result);
    },
  );
}

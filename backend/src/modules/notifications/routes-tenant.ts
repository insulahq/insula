/**
 * Tenant + user notification routes.
 *
 * Mount path: /api/v1
 *   - GET    /notifications/preferences
 *   - PATCH  /notifications/preferences
 *   - GET    /notifications/settings
 *   - PATCH  /notifications/settings
 *
 * All routes operate on the authenticated user's own preferences;
 * admin overrides happen via the admin surfaces.
 */
import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import {
  updateUserNotificationPreferencesSchema,
  updateUserNotificationSettingsSchema,
} from '@k8s-hosting/api-contracts';
import * as preferenceService from './preferences/service.js';

export async function notificationUserRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  app.get('/notifications/preferences', async (request) => {
    return success(await preferenceService.getUserPreferences(app.db, request.user!.sub));
  });

  app.patch('/notifications/preferences', async (request) => {
    const parsed = updateUserNotificationPreferencesSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${first.message} (${first.path.join('.')})`,
        400,
      );
    }
    const r = await preferenceService.updateUserPreferences(app.db, request.user!.sub, parsed.data);
    return success(r);
  });

  app.get('/notifications/settings', async (request) => {
    return success(await preferenceService.getUserSettings(app.db, request.user!.sub));
  });

  app.patch('/notifications/settings', async (request) => {
    const parsed = updateUserNotificationSettingsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${first.message} (${first.path.join('.')})`,
        400,
      );
    }
    const r = await preferenceService.updateUserSettings(app.db, request.user!.sub, parsed.data);
    return success(r);
  });
}

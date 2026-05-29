/**
 * Admin-only notification routes.
 *
 * Mount path: /api/v1/admin/notifications
 *
 * Surfaces:
 *   - GET    /categories                  list every category
 *   - PATCH  /categories/:id              edit category (channels, severity, rate-limit, active)
 *   - GET    /templates                   list templates (query: categoryId, channel, locale, includeArchived)
 *   - GET    /templates/:id               read one
 *   - PATCH  /templates/:id               edit subject/body (audit-logged, archives previous version)
 *   - POST   /templates/:id/preview       render against sample vars
 *   - POST   /templates/:id/restore-seed  revert to seed
 *   - GET    /deliveries                  audit log (cursor pagination, filters)
 *
 * All routes require panel='admin' and role super_admin OR admin.
 */
import type { FastifyInstance } from 'fastify';
import { eq, and, desc, lt, gt } from 'drizzle-orm';
import { authenticate, requirePanel, requireRole } from '../../middleware/auth.js';
import { success, paginated } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import {
  updateNotificationCategorySchema,
  updateNotificationTemplateSchema,
  previewNotificationTemplateSchema,
  listNotificationDeliveriesQuerySchema,
  createNotificationProviderSchema,
  updateNotificationProviderSchema,
  testNotificationProviderSchema,
} from '@insula/api-contracts';
import * as categoryService from './categories/service.js';
import * as templateService from './templates/service.js';
import * as providerService from './providers/service.js';
import { notificationDeliveries } from '../../db/schema.js';
import { enqueueDelivery } from './queue/enqueue.js';

const PROVIDERS_RATE_LIMIT_ERR =
  'PLATFORM_ENCRYPTION_KEY is required for notification provider operations (credential encryption)';

function requireEncryptionKey(): string {
  const key = process.env.PLATFORM_ENCRYPTION_KEY;
  if (!key) throw new ApiError('CONFIGURATION_ERROR', PROVIDERS_RATE_LIMIT_ERR, 500);
  return key;
}

export async function notificationAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('preHandler', requirePanel('admin'));
  app.addHook('preHandler', requireRole('super_admin', 'admin'));

  // ── Categories ────────────────────────────────────────────────────
  app.get('/admin/notifications/categories', async (request) => {
    const q = request.query as { audience?: 'tenant' | 'admin' | 'system'; include_inactive?: string };
    const data = await categoryService.listCategories(app.db, {
      audience: q.audience,
      includeInactive: q.include_inactive === 'true' || q.include_inactive === '1',
    });
    return success(data);
  });

  app.patch('/admin/notifications/categories/:id', async (request) => {
    const { id } = request.params as { id: string };
    const parsed = updateNotificationCategorySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${first.message} (${first.path.join('.')})`,
        400,
        { field: first.path.join('.') },
      );
    }
    const updated = await categoryService.updateCategory(app.db, id, parsed.data, {
      actorId: request.user!.sub,
    });
    return success(updated);
  });

  // ── Templates ─────────────────────────────────────────────────────
  app.get('/admin/notifications/templates', async (request) => {
    const q = request.query as {
      categoryId?: string;
      channel?: 'in_app' | 'email';
      locale?: string;
      includeInactive?: string;
    };
    const data = await templateService.listTemplates(app.db, {
      categoryId: q.categoryId,
      channel: q.channel,
      locale: q.locale,
      includeInactive: q.includeInactive === 'true' || q.includeInactive === '1',
    });
    return success(data);
  });

  app.get('/admin/notifications/templates/:id', async (request) => {
    const { id } = request.params as { id: string };
    return success(await templateService.getTemplate(app.db, id));
  });

  app.patch('/admin/notifications/templates/:id', async (request) => {
    const { id } = request.params as { id: string };
    const parsed = updateNotificationTemplateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${first.message} (${first.path.join('.')})`,
        400,
      );
    }
    const updated = await templateService.updateTemplate(app.db, id, parsed.data, {
      actorId: request.user!.sub,
    });
    return success(updated);
  });

  app.post('/admin/notifications/templates/:id/preview', async (request) => {
    const { id } = request.params as { id: string };
    const parsed = previewNotificationTemplateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${first.message} (${first.path.join('.')})`,
        400,
      );
    }
    const rendered = await templateService.previewTemplate(app.db, id, parsed.data);
    return success(rendered);
  });

  app.post('/admin/notifications/templates/:id/restore-seed', async (request) => {
    const { id } = request.params as { id: string };
    const restored = await templateService.restoreSeedTemplate(app.db, id, {
      actorId: request.user!.sub,
    });
    return success(restored);
  });

  // ── Deliveries (audit log) ────────────────────────────────────────
  app.get('/admin/notifications/deliveries', async (request) => {
    const parsed = listNotificationDeliveriesQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${first.message} (${first.path.join('.')})`,
        400,
      );
    }
    const q = parsed.data;
    const conditions = [];
    if (q.channel) conditions.push(eq(notificationDeliveries.channel, q.channel));
    if (q.status) conditions.push(eq(notificationDeliveries.status, q.status));
    if (q.categoryId) conditions.push(eq(notificationDeliveries.categoryId, q.categoryId));
    if (q.tenantId) conditions.push(eq(notificationDeliveries.tenantId, q.tenantId));
    if (q.sinceSeconds) {
      const cutoff = new Date(Date.now() - q.sinceSeconds * 1000);
      conditions.push(gt(notificationDeliveries.queuedAt, cutoff));
    }
    if (q.cursor) {
      const cursorDate = new Date(q.cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        conditions.push(lt(notificationDeliveries.queuedAt, cursorDate));
      }
    }

    const rows = await app.db
      .select()
      .from(notificationDeliveries)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(notificationDeliveries.queuedAt))
      .limit(q.limit + 1);

    const hasMore = rows.length > q.limit;
    const data = rows.slice(0, q.limit).map((r) => ({
      id: r.id,
      notificationId: r.notificationId,
      eventId: r.eventId,
      userId: r.userId,
      tenantId: r.tenantId,
      categoryId: r.categoryId,
      channel: r.channel,
      providerId: r.providerId,
      recipientHash: r.recipientHash,
      contentHash: r.contentHash,
      templateId: r.templateId,
      templateVersion: r.templateVersion,
      locale: r.locale,
      status: r.status,
      attempt: r.attempt,
      maxAttempts: r.maxAttempts,
      nextAttemptAt: r.nextAttemptAt?.toISOString() ?? null,
      lastError: r.lastError,
      providerMessageId: r.providerMessageId,
      queuedAt: r.queuedAt.toISOString(),
      sentAt: r.sentAt?.toISOString() ?? null,
      deliveredAt: r.deliveredAt?.toISOString() ?? null,
      failedAt: r.failedAt?.toISOString() ?? null,
    }));
    const last = data[data.length - 1];
    return paginated(data, {
      cursor: hasMore && last ? last.queuedAt : null,
      has_more: hasMore,
      page_size: q.limit,
    });
  });

  // POST /admin/notifications/deliveries/:id/retry — operator-driven
  // requeue of a failed or dead-letter delivery. Resets attempt + status
  // to 'queued' and re-enqueues the pg-boss job. Idempotent: refuses to
  // touch deliveries already in a non-terminal-error status so a
  // double-click can't reset a 'sending' row mid-flight.
  app.post('/admin/notifications/deliveries/:id/retry', async (request) => {
    const { id } = request.params as { id: string };
    const [row] = await app.db.select({
      id: notificationDeliveries.id,
      status: notificationDeliveries.status,
      channel: notificationDeliveries.channel,
    })
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, id))
      .limit(1);
    if (!row) {
      throw new ApiError('DELIVERY_NOT_FOUND', `Delivery '${id}' not found`, 404, { delivery_id: id });
    }
    if (row.channel !== 'email') {
      throw new ApiError(
        'OPERATION_NOT_ALLOWED',
        'Only email deliveries can be retried (in_app rows are written synchronously)',
        400,
      );
    }
    if (row.status !== 'failed' && row.status !== 'dlq') {
      throw new ApiError(
        'OPERATION_NOT_ALLOWED',
        `Cannot retry delivery in status '${row.status}' — only 'failed' or 'dlq' are retriable`,
        409,
        { current_status: row.status },
      );
    }
    await app.db.update(notificationDeliveries)
      .set({
        status: 'queued',
        attempt: 0,
        nextAttemptAt: null,
        lastError: null,
        failedAt: null,
      })
      .where(eq(notificationDeliveries.id, id));
    try {
      // Force a fresh singleton key so the queue doesn't dedupe against
      // a previous (terminal) job.
      await enqueueDelivery(id, { singletonKey: `delivery:${id}:manual-retry:${Date.now()}` });
    } catch (err) {
      // Soft warn — row is queued; a periodic scan can re-enqueue. The
      // operator should investigate pg-boss connectivity, but the
      // delivery isn't lost.
      app.log.warn({ err, delivery_id: id }, '[notifications] manual retry enqueue failed');
    }
    return success({ id, status: 'queued' });
  });

  // ── Providers (Phase 3B) ────────────────────────────────────────
  // Dedicated transport endpoint catalogue — distinct from
  // smtp_relay_configs (which is tenant-side outbound mail).
  app.get('/admin/notifications/providers', async () => {
    const rows = await providerService.listProviders(app.db);
    return success(rows);
  });

  app.get('/admin/notifications/providers/:id', async (request) => {
    const { id } = request.params as { id: string };
    return success(await providerService.getProvider(app.db, id));
  });

  app.post('/admin/notifications/providers', async (request) => {
    const parsed = createNotificationProviderSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${first.message} (${first.path.join('.')})`,
        400,
      );
    }
    const encryptionKey = requireEncryptionKey();
    const created = await providerService.createProvider(app.db, parsed.data, {
      userId: request.user!.sub,
      encryptionKey,
    });
    return success(created);
  });

  app.patch('/admin/notifications/providers/:id', async (request) => {
    const { id } = request.params as { id: string };
    const parsed = updateNotificationProviderSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${first.message} (${first.path.join('.')})`,
        400,
      );
    }
    const encryptionKey = requireEncryptionKey();
    const updated = await providerService.updateProvider(app.db, id, parsed.data, { encryptionKey });
    return success(updated);
  });

  app.delete('/admin/notifications/providers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await providerService.deleteProvider(app.db, id);
    reply.status(204).send();
  });

  app.post('/admin/notifications/providers/:id/test', async (request) => {
    const { id } = request.params as { id: string };
    const parsed = testNotificationProviderSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${first.message} (${first.path.join('.')})`,
        400,
      );
    }
    const encryptionKey = requireEncryptionKey();
    const result = await providerService.testProvider(app.db, id, parsed.data, { encryptionKey });
    return success(result);
  });
}

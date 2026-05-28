/**
 * Notification templates service.
 *
 * Resolution strategy: `getActiveTemplate(category, channel, locale)`
 * does an exact-match lookup first, then falls back to `en` locale,
 * then returns null (caller logs + skips delivery).
 *
 * Edit semantics: every PATCH archives the current row to
 * `notification_template_versions` (full snapshot) BEFORE bumping the
 * version on the live row. This is the operator-friendly undo path —
 * the admin UI surfaces the version history and a one-click "restore
 * this version" action.
 *
 * The `restoreSeedTemplate` admin op resets a row back to its seed
 * data (looks up the seed by category+channel+locale and overwrites
 * the live row).
 */
import { and, asc, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  notificationTemplates,
  notificationTemplateVersions,
  auditLogs,
} from '../../../db/schema.js';
import { ApiError } from '../../../shared/errors.js';
import { ALL_SEED_TEMPLATES } from './seed-data.js';
import { renderTemplateAsync, type RenderedTemplate } from './renderer.js';
import type {
  NotificationTemplateResponse,
  UpdateNotificationTemplateInput,
  PreviewNotificationTemplateInput,
  NotificationBodyFormat,
} from '@k8s-hosting/api-contracts';
import type { Database } from '../../../db/index.js';

interface ListTemplatesQuery {
  readonly categoryId?: string;
  readonly channel?: 'in_app' | 'email';
  readonly locale?: string;
  readonly includeInactive?: boolean;
}

type TemplateRow = typeof notificationTemplates.$inferSelect;

function rowToResponse(row: TemplateRow): NotificationTemplateResponse {
  return {
    id: row.id,
    categoryId: row.categoryId,
    channel: row.channel,
    locale: row.locale,
    subjectTemplate: row.subjectTemplate ?? null,
    bodyTemplate: row.bodyTemplate,
    bodyFormat: row.bodyFormat as NotificationBodyFormat,
    variablesSchema: (row.variablesSchema as NotificationTemplateResponse['variablesSchema']) ?? null,
    isActive: row.isActive,
    isSeed: row.isSeed,
    version: row.version,
    editedByUserId: row.editedByUserId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listTemplates(
  db: Database,
  q: ListTemplatesQuery = {},
): Promise<NotificationTemplateResponse[]> {
  const conditions = [];
  if (q.categoryId) conditions.push(eq(notificationTemplates.categoryId, q.categoryId));
  if (q.channel) conditions.push(eq(notificationTemplates.channel, q.channel));
  if (q.locale) conditions.push(eq(notificationTemplates.locale, q.locale));
  if (!q.includeInactive) conditions.push(eq(notificationTemplates.isActive, true));

  const rows = await db
    .select()
    .from(notificationTemplates)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(notificationTemplates.categoryId), asc(notificationTemplates.channel));
  return rows.map(rowToResponse);
}

export async function getTemplate(db: Database, id: string): Promise<NotificationTemplateResponse> {
  const [row] = await db
    .select()
    .from(notificationTemplates)
    .where(eq(notificationTemplates.id, id))
    .limit(1);
  if (!row) {
    throw new ApiError('TEMPLATE_NOT_FOUND', `Template '${id}' not found`, 404, { template_id: id });
  }
  return rowToResponse(row);
}

/**
 * Lookup the active template for a (category, channel, locale) tuple.
 * Falls back to `en` if no exact-locale match exists.
 * Returns null when neither exists — dispatcher logs + skips.
 */
export async function getActiveTemplate(
  db: Database,
  categoryId: string,
  channel: 'in_app' | 'email',
  locale: string,
): Promise<NotificationTemplateResponse | null> {
  const [exact] = await db
    .select()
    .from(notificationTemplates)
    .where(and(
      eq(notificationTemplates.categoryId, categoryId),
      eq(notificationTemplates.channel, channel),
      eq(notificationTemplates.locale, locale),
      eq(notificationTemplates.isActive, true),
    ))
    .orderBy(desc(notificationTemplates.version))
    .limit(1);
  if (exact) return rowToResponse(exact);

  if (locale !== 'en') {
    const [fallback] = await db
      .select()
      .from(notificationTemplates)
      .where(and(
        eq(notificationTemplates.categoryId, categoryId),
        eq(notificationTemplates.channel, channel),
        eq(notificationTemplates.locale, 'en'),
        eq(notificationTemplates.isActive, true),
      ))
      .orderBy(desc(notificationTemplates.version))
      .limit(1);
    if (fallback) return rowToResponse(fallback);
  }
  return null;
}

export interface UpdateTemplateContext {
  readonly actorId: string;
}

export async function updateTemplate(
  db: Database,
  id: string,
  input: UpdateNotificationTemplateInput,
  ctx: UpdateTemplateContext,
): Promise<NotificationTemplateResponse> {
  const existing = await getTemplate(db, id);

  // Archive the current row before mutating.
  try {
    await db.insert(notificationTemplateVersions).values({
      id: randomUUID(),
      templateId: existing.id,
      categoryId: existing.categoryId,
      channel: existing.channel,
      locale: existing.locale,
      subjectTemplate: existing.subjectTemplate,
      bodyTemplate: existing.bodyTemplate,
      bodyFormat: existing.bodyFormat,
      variablesSchema: existing.variablesSchema as readonly { name: string; type: string; required?: boolean }[] | null,
      version: existing.version,
      editedByUserId: existing.editedByUserId,
    });
  } catch {
    // Archive failure should not block the operator edit.
  }

  const patch: Record<string, unknown> = {
    version: existing.version + 1,
    editedByUserId: ctx.actorId,
    // Once an operator edits, mark non-seed so restore knows to overwrite.
    isSeed: false,
  };
  if (input.subjectTemplate !== undefined) patch.subjectTemplate = input.subjectTemplate;
  if (input.bodyTemplate !== undefined) patch.bodyTemplate = input.bodyTemplate;

  const [updated] = await db
    .update(notificationTemplates)
    .set(patch)
    .where(eq(notificationTemplates.id, id))
    .returning();
  if (!updated) throw new ApiError('TEMPLATE_NOT_FOUND', `Template '${id}' not found`, 404, { template_id: id });

  // Best-effort audit.
  try {
    await db.insert(auditLogs).values({
      id: randomUUID(),
      tenantId: null,
      actionType: 'notification.template.update',
      resourceType: 'notification_template',
      resourceId: id,
      actorId: ctx.actorId,
      actorType: 'user',
      httpMethod: 'PATCH',
      httpPath: `/api/v1/admin/notifications/templates/${id}`,
      httpStatus: 200,
      changes: { before: existing, after: rowToResponse(updated) },
      ipAddress: null,
    });
  } catch {
    // Swallow.
  }

  return rowToResponse(updated);
}

/**
 * Admin operation: revert the live template back to its seed data.
 * Archives the current row first.
 */
export async function restoreSeedTemplate(
  db: Database,
  id: string,
  ctx: UpdateTemplateContext,
): Promise<NotificationTemplateResponse> {
  const existing = await getTemplate(db, id);
  const seed = ALL_SEED_TEMPLATES.find(
    (s) => s.categoryId === existing.categoryId
      && s.channel === existing.channel
      && s.locale === existing.locale,
  );
  if (!seed) {
    throw new ApiError(
      'SEED_TEMPLATE_NOT_FOUND',
      `No seed template defined for ${existing.categoryId}/${existing.channel}/${existing.locale}`,
      404,
      { template_id: id },
    );
  }

  try {
    await db.insert(notificationTemplateVersions).values({
      id: randomUUID(),
      templateId: existing.id,
      categoryId: existing.categoryId,
      channel: existing.channel,
      locale: existing.locale,
      subjectTemplate: existing.subjectTemplate,
      bodyTemplate: existing.bodyTemplate,
      bodyFormat: existing.bodyFormat,
      variablesSchema: existing.variablesSchema as readonly { name: string; type: string; required?: boolean }[] | null,
      version: existing.version,
      editedByUserId: existing.editedByUserId,
    });
  } catch {
    // Archive failure should not block the restore.
  }

  const [updated] = await db
    .update(notificationTemplates)
    .set({
      subjectTemplate: seed.subjectTemplate,
      bodyTemplate: seed.bodyTemplate,
      bodyFormat: seed.bodyFormat,
      variablesSchema: seed.variablesSchema as readonly { name: string; type: string; required?: boolean }[] | null,
      version: existing.version + 1,
      isSeed: true,
      editedByUserId: ctx.actorId,
    })
    .where(eq(notificationTemplates.id, id))
    .returning();
  if (!updated) throw new ApiError('TEMPLATE_NOT_FOUND', `Template '${id}' not found`, 404, { template_id: id });
  return rowToResponse(updated);
}

/**
 * Render a template with sample vars for the admin preview pane.
 * Doesn't write any DB rows — pure compute over the live row.
 */
export async function previewTemplate(
  db: Database,
  id: string,
  input: PreviewNotificationTemplateInput,
): Promise<RenderedTemplate> {
  const template = await getTemplate(db, id);
  return renderTemplateAsync(template, input.variables);
}

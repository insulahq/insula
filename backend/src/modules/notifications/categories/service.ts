/**
 * Notification categories service — admin-facing CRUD over the
 * notification_categories table. Categories are seeded at boot
 * (seedCategoriesIfMissing); operator edits via PATCH only update a
 * whitelist of fields (defaultChannels, defaultSeverity, rate limits,
 * isActive). The display name, GDPR basis and isMandatory flags stay
 * code-owned to keep audit trails stable.
 */

import { eq, asc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { notificationCategories, auditLogs } from '../../../db/schema.js';
import { ApiError } from '../../../shared/errors.js';
import { ALL_CATEGORIES } from './seed.js';
import type {
  NotificationCategoryResponse,
  UpdateNotificationCategoryInput,
} from '@k8s-hosting/api-contracts';
import type { Database } from '../../../db/index.js';

interface ListCategoriesOptions {
  readonly audience?: 'tenant' | 'admin' | 'system';
  readonly includeInactive?: boolean;
}

/**
 * Idempotently insert every category in ALL_CATEGORIES. Re-runs on
 * every backend boot — INSERT ... ON CONFLICT DO NOTHING keeps it
 * cheap (~10ms on a warm DB).
 *
 * Edits made by the admin via PATCH are NEVER overwritten: we never
 * UPDATE on conflict, so operator-changed `defaultChannels` etc. stay
 * intact across restarts.
 */
export async function seedCategoriesIfMissing(db: Database): Promise<number> {
  if (ALL_CATEGORIES.length === 0) return 0;

  // Insert one row at a time; the table is tiny (<30 rows) and the
  // shape is heterogeneous (some have rate limits, some don't), so a
  // batch insert offers no measurable win and adds branching.
  let inserted = 0;
  for (const cat of ALL_CATEGORIES) {
    const result = await db
      .insert(notificationCategories)
      .values({
        id: cat.id,
        displayName: cat.displayName,
        description: cat.description,
        audience: cat.audience,
        defaultSeverity: cat.defaultSeverity,
        defaultChannels: cat.defaultChannels as string[],
        isMandatory: cat.isMandatory,
        gdprBasis: cat.gdprBasis,
        rateLimitWindowS: cat.rateLimitWindowS ?? null,
        rateLimitMax: cat.rateLimitMax ?? null,
        isActive: true,
      })
      .onConflictDoNothing({ target: notificationCategories.id })
      .returning({ id: notificationCategories.id });
    if (result.length > 0) inserted++;
  }
  return inserted;
}

function rowToResponse(row: typeof notificationCategories.$inferSelect): NotificationCategoryResponse {
  return {
    id: row.id,
    displayName: row.displayName,
    description: row.description ?? null,
    audience: row.audience as NotificationCategoryResponse['audience'],
    defaultSeverity: row.defaultSeverity,
    defaultChannels: (row.defaultChannels ?? []) as NotificationCategoryResponse['defaultChannels'],
    isMandatory: row.isMandatory,
    gdprBasis: row.gdprBasis,
    rateLimitWindowS: row.rateLimitWindowS ?? null,
    rateLimitMax: row.rateLimitMax ?? null,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listCategories(
  db: Database,
  opts: ListCategoriesOptions = {},
): Promise<NotificationCategoryResponse[]> {
  const rows = await db
    .select()
    .from(notificationCategories)
    .orderBy(asc(notificationCategories.audience), asc(notificationCategories.id));

  return rows
    .filter((r) => opts.audience === undefined || r.audience === opts.audience)
    .filter((r) => opts.includeInactive || r.isActive)
    .map(rowToResponse);
}

export async function getCategory(
  db: Database,
  id: string,
): Promise<NotificationCategoryResponse> {
  const [row] = await db
    .select()
    .from(notificationCategories)
    .where(eq(notificationCategories.id, id))
    .limit(1);
  if (!row) {
    throw new ApiError(
      'CATEGORY_NOT_FOUND',
      `Notification category '${id}' not found`,
      404,
      { category_id: id },
    );
  }
  return rowToResponse(row);
}

export interface UpdateCategoryContext {
  readonly actorId: string;
}

/**
 * Admin-only patch. Only updates the whitelist of editable fields —
 * everything else (display name, GDPR basis, mandatory flag) stays
 * code-owned. Writes an audit row with resource_type='notification_category'.
 */
export async function updateCategory(
  db: Database,
  id: string,
  input: UpdateNotificationCategoryInput,
  ctx: UpdateCategoryContext,
): Promise<NotificationCategoryResponse> {
  const existing = await getCategory(db, id);

  const patch: Record<string, unknown> = {};
  if (input.defaultChannels !== undefined) patch.defaultChannels = input.defaultChannels as string[];
  if (input.defaultSeverity !== undefined) patch.defaultSeverity = input.defaultSeverity;
  if (input.rateLimitWindowS !== undefined) patch.rateLimitWindowS = input.rateLimitWindowS;
  if (input.rateLimitMax !== undefined) patch.rateLimitMax = input.rateLimitMax;
  if (input.isActive !== undefined) patch.isActive = input.isActive;

  if (Object.keys(patch).length === 0) {
    return existing;
  }

  const [updated] = await db
    .update(notificationCategories)
    .set(patch)
    .where(eq(notificationCategories.id, id))
    .returning();

  if (!updated) {
    throw new ApiError('CATEGORY_NOT_FOUND', `Category '${id}' not found`, 404, { category_id: id });
  }

  // Best-effort audit. Failure must not break the operator patch.
  try {
    await db.insert(auditLogs).values({
      id: randomUUID(),
      tenantId: null,
      actionType: 'notification.category.update',
      resourceType: 'notification_category',
      resourceId: id.length <= 36 ? id : id.slice(0, 36),
      actorId: ctx.actorId,
      actorType: 'user',
      httpMethod: 'PATCH',
      httpPath: `/api/v1/admin/notifications/categories/${id}`,
      httpStatus: 200,
      changes: { before: existing, after: rowToResponse(updated) },
      ipAddress: null,
    });
  } catch {
    // Swallow: audit-log write failures should not break the API.
  }

  return rowToResponse(updated);
}

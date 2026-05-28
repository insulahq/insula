/**
 * Template seed loader — runs at boot, inserts ONE active row per
 * (category, channel, locale) only when no active row already exists.
 *
 * Operator edits are sacred: we NEVER UPDATE an existing row. The seed
 * pass is idempotent — second run inserts nothing.
 */
import { and, eq } from 'drizzle-orm';
import { notificationTemplates } from '../../../db/schema.js';
import { ALL_SEED_TEMPLATES } from './seed-data.js';
import type { Database } from '../../../db/index.js';

export async function seedTemplatesIfMissing(db: Database): Promise<number> {
  let inserted = 0;
  for (const tpl of ALL_SEED_TEMPLATES) {
    const [existing] = await db
      .select({ id: notificationTemplates.id })
      .from(notificationTemplates)
      .where(and(
        eq(notificationTemplates.categoryId, tpl.categoryId),
        eq(notificationTemplates.channel, tpl.channel),
        eq(notificationTemplates.locale, tpl.locale),
        eq(notificationTemplates.isActive, true),
      ))
      .limit(1);
    if (existing) continue;

    await db.insert(notificationTemplates).values({
      categoryId: tpl.categoryId,
      channel: tpl.channel,
      locale: tpl.locale,
      subjectTemplate: tpl.subjectTemplate,
      bodyTemplate: tpl.bodyTemplate,
      bodyFormat: tpl.bodyFormat,
      variablesSchema: tpl.variablesSchema as readonly { name: string; type: string; required?: boolean }[],
      isActive: true,
      isSeed: true,
      version: 1,
      editedByUserId: null,
    });
    inserted++;
  }
  return inserted;
}
